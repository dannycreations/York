import { Context, Data, Effect, Fiber, Layer, Option, PubSub, Ref, Schedule, Scope, Stream } from 'effect';
import { WebSocket as WsClient } from 'ws';

import type { ClientRequestArgs } from 'node:http';
import type { ClientOptions } from 'ws';

export type SocketEvent =
  | { readonly _tag: 'Open' }
  | { readonly _tag: 'Message'; readonly data: string }
  | { readonly _tag: 'Error'; readonly cause: unknown }
  | { readonly _tag: 'Close' };

export class SocketClientError extends Data.TaggedError('SocketClientError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SocketClientOptions {
  readonly url: string;
  readonly pingIntervalMs?: number;
  readonly pingTimeoutMs?: number;
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

export const createSocketClient = (options: SocketClientOptions): Effect.Effect<SocketClient, SocketClientError, Scope.Scope> =>
  Effect.gen(function* () {
    const {
      url,
      pingIntervalMs = 30_000,
      pingTimeoutMs = 10_000,
      reconnectBaseMs = 1_000,
      reconnectMaxMs = 60_000,
      reconnectMaxAttempts = Infinity,
      socketOptions = {},
    } = options;

    const eventsPubSub = yield* PubSub.unbounded<SocketEvent>();
    const wsRef = yield* Ref.make<Option.Option<WsClient>>(Option.none());
    const lastPongReceivedAt = yield* Ref.make(Date.now());
    const reconnectAttempts = yield* Ref.make(0);

    const disconnect = (graceful: boolean = false): Effect.Effect<void> =>
      Effect.gen(function* () {
        const wsOpt = yield* Ref.get(wsRef);
        if (Option.isSome(wsOpt)) {
          const ws = wsOpt.value;
          yield* Effect.sync(() => {
            ws.removeAllListeners();
            if (graceful) {
              ws.close(1000);
            } else {
              ws.terminate();
            }
          });
          yield* Ref.set(wsRef, Option.none());
          yield* PubSub.publish(eventsPubSub, { _tag: 'Close' });
        }
      });

    const connect: Effect.Effect<void, SocketClientError> = Effect.gen(function* () {
      const wsOpt = yield* Ref.get(wsRef);
      if (Option.isSome(wsOpt)) return;

      yield* Effect.logDebug(`SocketClient: Connecting to ${url}`);
      const ws = new WsClient(url, socketOptions);
      yield* Ref.set(wsRef, Option.some(ws));

      yield* Effect.async<void, SocketClientError>((resume) => {
        ws.once('open', () => {
          Effect.runFork(
            Effect.gen(function* () {
              yield* Ref.set(lastPongReceivedAt, Date.now());
              yield* Ref.set(reconnectAttempts, 0);
              yield* Effect.logDebug(`SocketClient: Connection established`);
              yield* PubSub.publish(eventsPubSub, { _tag: 'Open' });
              resume(Effect.void);
            }),
          );
        });

        ws.on('message', (data) => {
          const message = data.toString();
          Effect.runFork(PubSub.publish(eventsPubSub, { _tag: 'Message', data: message }));
        });

        ws.on('error', (cause) => {
          Effect.runFork(
            Effect.gen(function* () {
              yield* Effect.logError(`SocketClient: WebSocket error on ${url}`, cause);
              yield* PubSub.publish(eventsPubSub, { _tag: 'Error', cause });
            }),
          );
        });

        ws.on('close', (code) => {
          Effect.runFork(
            Effect.gen(function* () {
              yield* PubSub.publish(eventsPubSub, { _tag: 'Close' });
              yield* Ref.set(wsRef, Option.none());

              if (code === 1000) {
                yield* Effect.logInfo(`SocketClient: Connection closed gracefully on ${url}`);
                return;
              }

              const attempts = yield* Ref.get(reconnectAttempts);
              if (attempts >= reconnectMaxAttempts) {
                yield* Effect.logError(`SocketClient: Max reconnect attempts reached for ${url}`);
                return;
              }

              yield* Ref.update(reconnectAttempts, (n) => n + 1);
              const baseDelay = reconnectBaseMs * 1.5 ** attempts;
              const jitter = baseDelay * 0.4 * (Math.random() - 0.5);
              const delay = Math.min(reconnectMaxMs, Math.floor(baseDelay + jitter));

              yield* Effect.logDebug(
                `SocketClient: Reconnect attempt ${attempts + 1}/${reconnectMaxAttempts === Infinity ? '∞' : reconnectMaxAttempts} in ${delay}ms`,
              );
              yield* Effect.sleep(`${delay} millis`);
              yield* connect.pipe(Effect.ignore);
            }),
          );
        });

        ws.on('pong', () => {
          Effect.runFork(Ref.set(lastPongReceivedAt, Date.now()));
        });
      });
    });

    const pingLoop = Effect.gen(function* () {
      const lastPong = yield* Ref.get(lastPongReceivedAt);
      const now = Date.now();
      if (now - lastPong > pingIntervalMs + pingTimeoutMs) {
        yield* Effect.logWarning(`SocketClient: Ping timeout on ${url}, reconnecting`);
        yield* disconnect(false);
        yield* connect.pipe(Effect.ignore);
        return;
      }
      const wsOpt = yield* Ref.get(wsRef);
      if (Option.isSome(wsOpt)) {
        yield* Effect.sync(() => wsOpt.value.ping());
      }
    }).pipe(Effect.repeat(Schedule.spaced(`${pingIntervalMs} millis`)));

    yield* connect;
    const pingFiber = yield* Effect.fork(pingLoop);

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Fiber.interrupt(pingFiber);
        yield* disconnect(true);
      }),
    );

    const send = (payload: string | object): Effect.Effect<void, SocketClientError> =>
      Effect.gen(function* () {
        const wsOpt = yield* Ref.get(wsRef);
        if (Option.isNone(wsOpt)) {
          return yield* Effect.fail(new SocketClientError({ message: 'SocketClient: Not connected' }));
        }
        const ws = wsOpt.value;
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        yield* Effect.async<void, SocketClientError>((resume) => {
          ws.send(data, (err) => {
            if (err) {
              resume(Effect.fail(new SocketClientError({ message: 'SocketClient: Failed to send message', cause: err })));
            } else {
              resume(Effect.void);
            }
          });
        });
      });

    return {
      send,
      events: Stream.fromPubSub(eventsPubSub),
      connect,
      disconnect,
    } satisfies SocketClient;
  });

export const SocketClientLayer = <S>(tag: Context.Tag<S, SocketClient>, options: SocketClientOptions) =>
  Layer.scoped(tag, createSocketClient(options));
