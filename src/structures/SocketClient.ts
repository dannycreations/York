import { NodeWS } from '@effect/platform-node';
import { Cause, Context, Data, Deferred, Duration, Effect, Exit, Layer, Option, PubSub, Ref, Schedule, Scope, Stream } from 'effect';
import { Socket } from 'effect/socket';

import { HttpClientTag } from './HttpClient.js';

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

const isCleanSocketClose = (error: unknown): boolean =>
  Socket.isSocketError(error) && error.reason._tag === 'SocketCloseError' && (error.reason.code === 1000 || error.reason.code === 1006);

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
    const runFiberRef = yield* Ref.make<Option.Option<Scope.Closeable>>(Option.none());
    const socketRef = yield* Ref.make<Option.Option<Socket.Socket>>(Option.none());
    const openedDeferredRef = yield* Ref.make(yield* Deferred.make<void, SocketClientError>());

    const disconnect = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        const scopeOpt = yield* Ref.getAndSet(runFiberRef, Option.none());

        if (Option.isSome(scopeOpt)) {
          yield* Scope.close(scopeOpt.value, Exit.void);
        }

        yield* Ref.set(socketRef, Option.none());

        const currentDeferred = yield* Ref.get(openedDeferredRef);
        yield* Deferred.fail(currentDeferred, new SocketClientError({ message: 'Socket disconnected manually' })).pipe(Effect.ignore);

        const nextDeferred = yield* Deferred.make<void, SocketClientError>();
        yield* Ref.set(openedDeferredRef, nextDeferred);

        yield* PubSub.publish(eventsPubSub, SocketEvent.Close());
      });

    const connect = Effect.gen(function* () {
      const isConnecting = yield* Ref.getAndUpdate(isConnectingRef, () => true);

      if (isConnecting) {
        const currentDeferred = yield* Ref.get(openedDeferredRef);
        return yield* Deferred.await(currentDeferred);
      }

      const currentSocket = yield* Ref.get(socketRef);

      if (Option.isSome(currentSocket)) {
        yield* Ref.set(isConnectingRef, false);
        return;
      }

      const scope = yield* Scope.make();
      yield* Ref.set(runFiberRef, Option.some(scope));

      const opened = yield* Deferred.make<void, SocketClientError>();

      const runLoop = Effect.gen(function* () {
        yield* httpClient.waitForConnection();

        yield* Effect.logDebug(`SocketClient: Connecting to ${url}`);
        const socket = yield* Socket.makeWebSocket(url).pipe(Effect.provide(NodeWS.layerWebSocketConstructor));

        return yield* Effect.gen(function* () {
          // Acquiring the reader dials the WebSocket and waits for it to open.
          const reader = yield* socket.reader;

          yield* Effect.logDebug('SocketClient: Connection established');
          yield* Ref.set(lastPongReceivedAt, Date.now());
          yield* Ref.set(socketRef, Option.some(socket));
          yield* PubSub.publish(eventsPubSub, SocketEvent.Open());
          yield* Deferred.succeed(opened, undefined);
          const currentOpened = yield* Ref.get(openedDeferredRef);
          yield* Deferred.succeed(currentOpened, undefined).pipe(Effect.ignore);

          while (true) {
            const chunks = yield* reader.pull;

            for (const chunk of chunks) {
              const data = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
              yield* Ref.set(lastPongReceivedAt, Date.now());
              yield* PubSub.publish(eventsPubSub, SocketEvent.Message({ data }));
            }
          }
        }).pipe(Effect.scoped);
      }).pipe(
        Effect.scoped,
        Effect.catchIf(isCleanSocketClose, () => Effect.void),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (!Cause.hasInterruptsOnly(cause)) {
              yield* Effect.logError('SocketClient: WebSocket error', cause);
            }
            const error = new SocketClientError({ message: 'WebSocket error', cause });
            const currentOpened = yield* Ref.get(openedDeferredRef);
            yield* Deferred.fail(currentOpened, error).pipe(Effect.ignore);
            yield* PubSub.publish(eventsPubSub, SocketEvent.Error({ cause }));
            return yield* Effect.failCause(cause);
          }),
        ),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            yield* Ref.set(socketRef, Option.none());

            const currentDeferred = yield* Ref.get(openedDeferredRef);
            yield* Deferred.fail(currentDeferred, new SocketClientError({ message: 'Connection lost' })).pipe(Effect.ignore);

            const nextDeferred = yield* Deferred.make<void, SocketClientError>();
            yield* Ref.set(openedDeferredRef, nextDeferred);
            yield* PubSub.publish(eventsPubSub, SocketEvent.Close());

            if (exit._tag === 'Failure' && !Exit.hasInterrupts(exit)) {
              const failureError = new SocketClientError({ message: 'Fatal connection failure' });
              yield* Deferred.fail(opened, failureError).pipe(Effect.ignore);
              return;
            }

            const closeError = new SocketClientError({ message: 'Connection closed' });
            yield* Deferred.fail(opened, closeError).pipe(Effect.ignore);
          }),
        ),
        Effect.retry(
          Schedule.max([Schedule.exponential(`${reconnectBaseMs} millis`, 1.5), Schedule.recurs(reconnectMaxAttempts)]).pipe(
            Schedule.map(({ output }) => Duration.min(output, Duration.millis(reconnectMaxMs))),
            Schedule.tap(({ output }) => Effect.logDebug(`SocketClient: Reconnecting in ${Duration.toMillis(output)}ms`)),
          ),
        ),
        Effect.ignore,
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

          if (Exit.hasInterrupts(exit)) {
            return;
          }

          return yield* Effect.failCause(exit.cause);
        }).pipe(Effect.ignoreCause),
      ),
    );

    const send = (payload: string | object): Effect.Effect<void, SocketClientError, Scope.Scope> =>
      Effect.gen(function* () {
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);

        const writeLoop: Effect.Effect<void, SocketClientError, Scope.Scope> = Effect.gen(function* () {
          const socketOpt = yield* Ref.get(socketRef);

          if (Option.isNone(socketOpt)) {
            const opened = yield* Ref.get(openedDeferredRef);
            yield* Deferred.await(opened).pipe(
              Effect.catchIf(
                (err) => !err.message.includes('disconnected manually'),
                () => Effect.void,
              ),
            );
            return yield* writeLoop;
          }

          const writer = yield* socketOpt.value.writer;
          return yield* writer
            .write(new TextEncoder().encode(data))
            .pipe(Effect.mapError((cause) => new SocketClientError({ message: 'Failed to send message', cause })));
        });

        return yield* writeLoop;
      });

    const pingLoop = Effect.gen(function* () {
      const isConnecting = yield* Ref.get(isConnectingRef);
      if (isConnecting) {
        return;
      }

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
      const isConnecting = yield* Ref.get(isConnectingRef);
      if (isConnecting) {
        return;
      }

      const socketOpt = yield* Ref.get(socketRef);

      if (Option.isNone(socketOpt)) {
        return;
      }

      const lastPong = yield* Ref.get(lastPongReceivedAt);
      const now = Date.now();

      if (now - lastPong <= pingIntervalMs + pingTimeoutMs) {
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
  tag: Context.Key<I, S>,
  options: SocketClientOptions,
): Layer.Layer<I, SocketClientError, HttpClientTag> =>
  Layer.effect(tag, makeSocketClient(options).pipe(Effect.map((client) => client as unknown as S)));
