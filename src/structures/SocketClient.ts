import { Context, Data, Deferred, Effect, Layer, Option, PubSub, Queue, Ref, Schedule, Scope, Stream } from 'effect';
import { WebSocket as WsClient } from 'ws';

import { HttpClientTag } from './HttpClient';

import type { ClientRequestArgs } from 'node:http';
import type { ClientOptions } from 'ws';

type SocketState = Data.TaggedEnum<{
  Open: {};
  Message: { readonly data: string };
  Error: { readonly cause: unknown };
  Close: {};
  Pong: {};
}>;

const SocketState = Data.taggedEnum<SocketState>();

export type SocketEvent = Exclude<SocketState, { readonly _tag: 'Pong' }>;

export class SocketClientError extends Data.TaggedError('SocketClientError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SocketClientOptions {
  readonly url: string;
  readonly pingIntervalMs?: number;
  readonly pingTimeoutMs?: number;
  readonly pingPayload?: string | object;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly reconnectMaxAttempts?: number;
  readonly socketOptions?: ClientOptions | ClientRequestArgs;
}

export interface SocketClient {
  readonly send: (payload: string | object) => Effect.Effect<void, SocketClientError>;
  readonly events: Stream.Stream<SocketEvent, never, never>;
  readonly connect: Effect.Effect<void, SocketClientError>;
  readonly disconnect: (graceful?: boolean) => Effect.Effect<void>;
}

export const makeSocketClient = (options: SocketClientOptions): Effect.Effect<SocketClient, SocketClientError, Scope.Scope | HttpClientTag> =>
  Effect.gen(function* () {
    const {
      url,
      pingIntervalMs = 30_000,
      pingTimeoutMs = 10_000,
      pingPayload,
      reconnectBaseMs = 1_000,
      reconnectMaxMs = 60_000,
      reconnectMaxAttempts = Infinity,
      socketOptions = {},
    } = options;

    const eventsPubSub = yield* PubSub.unbounded<SocketEvent>();
    const wsRef = yield* Ref.make<Option.Option<WsClient>>(Option.none());
    const openedDeferredRef = yield* Ref.make(yield* Deferred.make<void>());
    const sendQueue = yield* Queue.unbounded<{
      readonly data: string;
      readonly deferred: Deferred.Deferred<void, SocketClientError>;
    }>();

    const processSendQueue = Queue.take(sendQueue).pipe(
      Effect.flatMap(({ data, deferred }) => {
        const waitForReady = Effect.gen(function* () {
          const openedDeferred = yield* Ref.get(openedDeferredRef);
          yield* Deferred.await(openedDeferred);

          const wsOpt = yield* Ref.get(wsRef);
          if (Option.isNone(wsOpt)) {
            yield* Effect.sleep('1 seconds');
            return yield* Effect.fail('Not Ready');
          }

          const ws = wsOpt.value;
          if (ws.readyState !== WsClient.OPEN || ws.bufferedAmount > 1_048_576) {
            yield* Effect.sleep('100 millis');
            return yield* Effect.fail('Not Ready');
          }

          return ws;
        }).pipe(Effect.retry({ while: (e): e is string => e === 'Not Ready' }));

        const sendTask = Effect.gen(function* () {
          const ws = yield* waitForReady.pipe(Effect.mapError((e) => new SocketClientError({ message: String(e) })));
          return yield* Effect.async<void, SocketClientError>((resume) => {
            ws.send(data, (err) => {
              if (err) {
                resume(Effect.fail(new SocketClientError({ message: 'SocketClient: Failed to send message', cause: err })));
              } else {
                resume(Effect.void);
              }
            });
          });
        }).pipe(
          Effect.retry({
            schedule: Schedule.exponential('1 seconds').pipe(Schedule.compose(Schedule.recurs(2))),
          }),
        );

        return Effect.matchEffect(sendTask, {
          onFailure: (err) => Deferred.fail(deferred, err),
          onSuccess: () => Deferred.succeed(deferred, undefined),
        });
      }),
      Effect.forever,
    );

    yield* Effect.forkScoped(processSendQueue);

    const lastPongReceivedAt = yield* Ref.make(Date.now());
    const reconnectAttempts = yield* Ref.make(0);

    const disconnect = (graceful = false): Effect.Effect<void> =>
      Ref.get(wsRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (ws) =>
              Effect.gen(function* () {
                yield* Effect.sync(() => {
                  ws.removeAllListeners();
                  // SAFETY: Prevent late error
                  ws.on('error', () => {});
                  if (graceful) {
                    ws.close(1000);
                  } else {
                    ws.terminate();
                  }
                });
                yield* Ref.set(wsRef, Option.none());
                const nextDeferred = yield* Deferred.make<void>();
                yield* Ref.set(openedDeferredRef, nextDeferred);
                yield* PubSub.publish(eventsPubSub, SocketState.Close());
              }),
          }),
        ),
      );

    const makeRawStream = (ws: WsClient): Stream.Stream<SocketState, never, never> =>
      Stream.async<SocketState>((emit) => {
        ws.once('open', () => emit.single(SocketState.Open()));
        ws.on('message', (data) => emit.single(SocketState.Message({ data: data.toString() })));
        ws.on('error', (cause) => emit.single(SocketState.Error({ cause })));
        ws.on('close', () => emit.single(SocketState.Close()));
        ws.on('pong', () => emit.single(SocketState.Pong()));
      });

    const connect: Effect.Effect<void, SocketClientError, HttpClientTag | Scope.Scope> = Effect.gen(function* () {
      const wsOpt = yield* Ref.get(wsRef);
      if (Option.isSome(wsOpt)) return;

      const httpClient = yield* HttpClientTag;
      yield* httpClient.waitForConnection().pipe(Effect.ignore);

      yield* Effect.logDebug(`SocketClient: Connecting to ${url}`);
      const ws = yield* Effect.sync(() => new WsClient(url, socketOptions));
      yield* Ref.set(wsRef, Option.some(ws));

      const opened = yield* Deferred.make<void, SocketClientError>();

      yield* makeRawStream(ws).pipe(
        Stream.tap((event) =>
          Effect.gen(function* () {
            switch (event._tag) {
              case 'Message':
              case 'Pong': {
                yield* Ref.set(lastPongReceivedAt, Date.now());
                break;
              }
              case 'Open': {
                yield* Ref.set(lastPongReceivedAt, Date.now());
                yield* Ref.set(reconnectAttempts, 0);
                yield* Effect.logDebug('SocketClient: Connection established');
                yield* Deferred.succeed(opened, undefined);
                const currentOpened = yield* Ref.get(openedDeferredRef);
                yield* Deferred.succeed(currentOpened, undefined);
                break;
              }
              case 'Error': {
                yield* Effect.logError('SocketClient: WebSocket error', event.cause);
                break;
              }
              case 'Close': {
                yield* Ref.set(wsRef, Option.none());
                const nextDeferred = yield* Deferred.make<void>();
                yield* Ref.set(openedDeferredRef, nextDeferred);
                const attempts = yield* Ref.get(reconnectAttempts);
                if (attempts < reconnectMaxAttempts) {
                  yield* Ref.update(reconnectAttempts, (n) => n + 1);
                  const baseDelay = reconnectBaseMs * 1.5 ** attempts;
                  const jitter = baseDelay * 0.4 * (Math.random() - 0.5);
                  const delay = Math.min(reconnectMaxMs, Math.floor(baseDelay + jitter));
                  yield* Effect.logDebug(
                    `SocketClient: Reconnect attempt ${attempts + 1}/${reconnectMaxAttempts === Infinity ? '∞' : reconnectMaxAttempts} in ${delay}ms`,
                  );
                  yield* Effect.sleep(`${delay} millis`).pipe(
                    Effect.flatMap(() => connect.pipe(Effect.ignore)),
                    Effect.forkScoped,
                  );
                } else {
                  yield* Effect.logError('SocketClient: Max reconnect attempts reached');
                }
                break;
              }
            }
          }),
        ),
        Stream.runForEach((event) => (event._tag === 'Pong' ? Effect.void : PubSub.publish(eventsPubSub, event))),
        Effect.forkScoped,
      );

      return yield* Deferred.await(opened);
    });

    const pingLoop = Effect.gen(function* () {
      const lastPong = yield* Ref.get(lastPongReceivedAt);
      const now = Date.now();
      if (now - lastPong > pingIntervalMs + pingTimeoutMs) {
        yield* Effect.logWarning('SocketClient: Ping timeout, reconnecting...');
        yield* disconnect(false);
        yield* connect.pipe(Effect.ignore);
        return;
      }
      const wsOpt = yield* Ref.get(wsRef);
      if (Option.isSome(wsOpt) && wsOpt.value.readyState === WsClient.OPEN) {
        if (pingPayload) {
          yield* send(pingPayload);
        } else {
          yield* Effect.sync(() => wsOpt.value.ping());
        }
      }
    }).pipe(Effect.repeat(Schedule.spaced(`${pingIntervalMs} millis`)));

    yield* connect;
    yield* Effect.forkScoped(pingLoop);
    yield* Effect.addFinalizer(() => disconnect(true));

    const send = (payload: string | object): Effect.Effect<void, SocketClientError> =>
      Effect.gen(function* () {
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const deferred = yield* Deferred.make<void, SocketClientError>();
        yield* Queue.offer(sendQueue, { data, deferred });
        return yield* Deferred.await(deferred);
      });

    return {
      send,
      connect: connect as Effect.Effect<void, SocketClientError>,
      disconnect,
      events: Stream.fromPubSub(eventsPubSub),
    } satisfies SocketClient;
  });

export const SocketClientLayer = <I, S extends SocketClient>(
  tag: Context.Tag<I, S>,
  options: SocketClientOptions,
): Layer.Layer<I, SocketClientError, HttpClientTag> =>
  Layer.scoped(tag, makeSocketClient(options).pipe(Effect.map((client) => client as unknown as S)));
