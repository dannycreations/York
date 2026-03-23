import { Socket } from '@effect/platform';
import { NodeSocket } from '@effect/platform-node';
import { Context, Data, Deferred, Duration, Effect, Exit, Layer, Option, PubSub, Queue, Ref, Schedule, Scope, Stream } from 'effect';

import { HttpClientTag } from './HttpClient';

export type SocketEvent = Data.TaggedEnum<{
  Open: {};
  Message: { readonly data: string };
  Error: { readonly cause: unknown };
  Close: {};
}>;

export const SocketEvent = Data.taggedEnum<SocketEvent>();

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
}

export interface SocketClient {
  readonly send: (payload: string | object) => Effect.Effect<void, SocketClientError>;
  readonly events: Stream.Stream<SocketEvent, never, never>;
  readonly connect: Effect.Effect<void, SocketClientError>;
  readonly disconnect: (graceful?: boolean) => Effect.Effect<void>;
}

export const makeSocketClient = (options: SocketClientOptions): Effect.Effect<SocketClient, SocketClientError, HttpClientTag | Scope.Scope> =>
  Effect.gen(function* () {
    const {
      url,
      pingIntervalMs = 30_000,
      pingTimeoutMs = 10_000,
      pingPayload,
      reconnectBaseMs = 1_000,
      reconnectMaxMs = 60_000,
      reconnectMaxAttempts = Infinity,
    } = options;

    const httpClient = yield* HttpClientTag;
    const eventsPubSub = yield* PubSub.unbounded<SocketEvent>();
    const lastPongReceivedAt = yield* Ref.make(Date.now());
    const isConnectingRef = yield* Ref.make(false);
    const runFiberRef = yield* Ref.make<Option.Option<Scope.CloseableScope>>(Option.none());
    const socketRef = yield* Ref.make<Option.Option<Socket.Socket>>(Option.none());
    const openedDeferredRef = yield* Ref.make(yield* Deferred.make<void, SocketClientError>());

    const disconnect = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const scopeOpt = yield* Ref.getAndSet(runFiberRef, Option.none());

        if (Option.isSome(scopeOpt)) {
          yield* Scope.close(scopeOpt.value, Exit.void);
        }

        yield* Ref.set(socketRef, Option.none());

        const nextDeferred = yield* Deferred.make<void, SocketClientError>();
        yield* Ref.set(openedDeferredRef, nextDeferred);

        yield* PubSub.publish(eventsPubSub, SocketEvent.Close());
      });

    const connect = Effect.gen(function* () {
      const isConnecting = yield* Ref.getAndUpdate(isConnectingRef, () => true);

      if (isConnecting) {
        return;
      }

      const currentSocket = yield* Ref.get(socketRef);

      if (Option.isSome(currentSocket)) {
        yield* Ref.set(isConnectingRef, false);
        return;
      }

      yield* httpClient.waitForConnection();

      const scope = yield* Scope.make();
      yield* Ref.set(runFiberRef, Option.some(scope));

      const opened = yield* Deferred.make<void, SocketClientError>();

      const writeQueue = yield* Queue.unbounded<{
        readonly data: string;
        readonly deferred: Deferred.Deferred<void, SocketClientError>;
      }>();

      const runLoop = Effect.gen(function* () {
        yield* Effect.logDebug(`SocketClient: Connecting to ${url}`);
        const socket = yield* Socket.makeWebSocket(url).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor));
        yield* Ref.set(socketRef, Option.some(socket));

        yield* Effect.gen(function* () {
          const write = yield* socket.writer;
          return yield* Queue.take(writeQueue).pipe(
            Effect.flatMap(({ data, deferred }) =>
              write(new TextEncoder().encode(data)).pipe(
                Effect.mapError((cause) => new SocketClientError({ message: 'Failed to send message', cause })),
                Effect.matchEffect({
                  onFailure: (err) => Deferred.fail(deferred, err),
                  onSuccess: () => Deferred.succeed(deferred, undefined),
                }),
              ),
            ),
            Effect.forever,
          );
        }).pipe(Effect.forkScoped);

        yield* socket.run(
          (chunk: Uint8Array) =>
            Effect.gen(function* () {
              const data = new TextDecoder().decode(chunk);
              yield* Ref.set(lastPongReceivedAt, Date.now());
              yield* PubSub.publish(eventsPubSub, SocketEvent.Message({ data }));
            }),
          {
            onOpen: Effect.gen(function* () {
              yield* Effect.logDebug('SocketClient: Connection established');
              yield* Ref.set(lastPongReceivedAt, Date.now());
              yield* PubSub.publish(eventsPubSub, SocketEvent.Open());
              yield* Deferred.succeed(opened, undefined);
              const currentOpened = yield* Ref.get(openedDeferredRef);
              yield* Deferred.succeed(currentOpened, undefined);
            }),
          },
        );
      }).pipe(
        Effect.scoped,
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError('SocketClient: WebSocket error', cause);
            const error = new SocketClientError({ message: 'WebSocket error', cause });
            const currentOpened = yield* Ref.get(openedDeferredRef);
            yield* Deferred.fail(currentOpened, error);
            yield* PubSub.publish(eventsPubSub, SocketEvent.Error({ cause }));
            return yield* Effect.failCause(cause);
          }),
        ),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            yield* Ref.set(socketRef, Option.none());
            const nextDeferred = yield* Deferred.make<void, SocketClientError>();
            yield* Ref.set(openedDeferredRef, nextDeferred);
            yield* PubSub.publish(eventsPubSub, SocketEvent.Close());

            if (exit._tag === 'Failure' && !Exit.isInterrupted(exit)) {
              const failureError = new SocketClientError({ message: 'Fatal connection failure' });
              yield* Deferred.fail(opened, failureError);
              return;
            }

            const closeError = new SocketClientError({ message: 'Connection closed' });
            yield* Deferred.fail(opened, closeError);
          }),
        ),
        Effect.retry(
          Schedule.exponential(`${reconnectBaseMs} millis`, 1.5).pipe(
            Schedule.intersect(Schedule.recurs(reconnectMaxAttempts)),
            Schedule.map((out) => Duration.min(out[0], Duration.millis(reconnectMaxMs))),
            Schedule.tapOutput((delay) => Effect.logDebug(`SocketClient: Reconnecting in ${Duration.toMillis(delay)}ms`)),
          ),
        ),
        Effect.catchAll(() => Effect.void),
        Effect.repeat(Schedule.spaced('1 seconds')),
      );

      yield* Effect.forkIn(runLoop, scope);

      try {
        yield* Deferred.await(opened);
      } finally {
        yield* Ref.set(isConnectingRef, false);
      }
    }).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* Ref.set(isConnectingRef, false);
          if (exit._tag !== 'Failure') {
            return;
          }

          if (Exit.isInterrupted(exit)) {
            return;
          }

          return yield* Effect.failCause(exit.cause);
        }).pipe(Effect.catchAllCause(() => Effect.void)),
      ),
    );

    const send = (payload: string | object): Effect.Effect<void, SocketClientError, Scope.Scope> =>
      Effect.gen(function* () {
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);

        const writeLoop: Effect.Effect<void, SocketClientError, Scope.Scope> = Effect.gen(function* () {
          const socketOpt = yield* Ref.get(socketRef);

          if (Option.isNone(socketOpt)) {
            const opened = yield* Ref.get(openedDeferredRef);
            yield* Deferred.await(opened);
            return yield* writeLoop;
          }

          const write = yield* socketOpt.value.writer;
          yield* write(new TextEncoder().encode(data));
        }).pipe(Effect.mapError((cause) => new SocketClientError({ message: 'Failed to send message', cause })));

        return yield* writeLoop;
      });

    const pingLoop = Effect.gen(function* () {
      const socketOpt = yield* Ref.get(socketRef);
      if (Option.isNone(socketOpt)) {
        return;
      }

      if (!pingPayload) {
        return;
      }

      yield* send(pingPayload);
    }).pipe(Effect.repeat(Schedule.spaced(`${pingIntervalMs} millis`)));

    const timeoutLoop = Effect.gen(function* () {
      const socketOpt = yield* Ref.get(socketRef);

      if (Option.isNone(socketOpt)) {
        return;
      }

      const lastPong = yield* Ref.get(lastPongReceivedAt);
      const now = Date.now();
      const isTimeout = now - lastPong > pingIntervalMs + pingTimeoutMs;

      if (!isTimeout) {
        return;
      }

      yield* Effect.logWarning('SocketClient: Ping timeout, reconnecting...');
      yield* disconnect();
      yield* connect;
    }).pipe(Effect.repeat(Schedule.spaced('5 seconds')));

    const parentScope = yield* Effect.scope;
    yield* connect.pipe(Effect.provideService(Scope.Scope, parentScope));
    yield* Effect.forkScoped(pingLoop);
    yield* Effect.forkScoped(timeoutLoop);
    yield* Effect.addFinalizer(() => disconnect());

    return {
      send: (payload) => send(payload).pipe(Effect.provideService(Scope.Scope, parentScope)) as Effect.Effect<void, SocketClientError>,
      connect: connect.pipe(Effect.provideService(Scope.Scope, parentScope)) as Effect.Effect<void, SocketClientError>,
      disconnect,
      events: Stream.fromPubSub(eventsPubSub),
    } satisfies SocketClient;
  });

export const SocketClientLayer = <I, S extends SocketClient>(
  tag: Context.Tag<I, S>,
  options: SocketClientOptions,
): Layer.Layer<I, SocketClientError, HttpClientTag> =>
  Layer.scoped(tag, makeSocketClient(options).pipe(Effect.map((client) => client as unknown as S)));
