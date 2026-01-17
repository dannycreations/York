import { Context, Data, Effect, Fiber, Layer, Option, PubSub, Ref, Schedule, Stream } from 'effect';
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
  readonly reconnectDelayMs?: number;
  readonly socketOptions?: ClientOptions | ClientRequestArgs;
}

export interface SocketClient {
  readonly send: (payload: string | object) => Effect.Effect<void, SocketClientError>;
  readonly events: Stream.Stream<SocketEvent, never, never>;
  readonly connect: Effect.Effect<void, SocketClientError>;
  readonly disconnect: (reconnect?: boolean) => Effect.Effect<void>;
}

export const createSocketClient = (options: SocketClientOptions) =>
  Effect.gen(function* () {
    const { url, pingIntervalMs = 30_000, pingTimeoutMs = 10_000, reconnectDelayMs = 5_000, socketOptions = {} } = options;

    const eventsPubSub = yield* PubSub.unbounded<SocketEvent>();
    const wsRef = yield* Ref.make<Option.Option<WsClient>>(Option.none());
    const lastPongReceivedAt = yield* Ref.make(Date.now());

    const disconnect = (reconnect: boolean = false): Effect.Effect<void> =>
      Effect.gen(function* () {
        const wsOpt = yield* Ref.get(wsRef);
        if (Option.isSome(wsOpt)) {
          const ws = wsOpt.value;
          yield* Effect.sync(() => {
            ws.removeAllListeners();
            ws.terminate();
          });
          yield* Ref.set(wsRef, Option.none());
          yield* PubSub.publish(eventsPubSub, { _tag: 'Close' });
        }
        if (reconnect) {
          yield* connect.pipe(Effect.ignore);
        }
      });

    const connect: Effect.Effect<void, SocketClientError> = Effect.gen(function* () {
      const ws = new WsClient(url, socketOptions);
      yield* Ref.set(wsRef, Option.some(ws));

      yield* Effect.async<void, SocketClientError>((resume) => {
        ws.on('open', () => {
          Effect.runFork(
            Effect.gen(function* () {
              yield* Ref.set(lastPongReceivedAt, Date.now());
              yield* Effect.logDebug(`SocketClient: Connected to ${url}`);
              yield* PubSub.publish(eventsPubSub, { _tag: 'Open' });
              resume(Effect.void);
            }),
          );
        });

        ws.on('message', (data) => {
          const message = data.toString();
          Effect.runFork(
            Effect.gen(function* () {
              yield* PubSub.publish(eventsPubSub, { _tag: 'Message', data: message });
            }),
          );
        });

        ws.on('error', (cause) => {
          Effect.runFork(
            Effect.gen(function* () {
              yield* Effect.logError(`SocketClient: WebSocket error on ${url}`, cause);
              yield* PubSub.publish(eventsPubSub, { _tag: 'Error', cause });
            }),
          );
        });

        ws.on('close', () => {
          Effect.runFork(
            Effect.gen(function* () {
              yield* Effect.logWarning(`SocketClient: Connection closed on ${url}, reconnecting in ${reconnectDelayMs / 1000}s`);
              yield* PubSub.publish(eventsPubSub, { _tag: 'Close' });
              yield* Effect.sleep(`${reconnectDelayMs} millis`);
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
        yield* disconnect(true);
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
        yield* disconnect(false);
      }),
    );

    const send = (payload: string | object) =>
      Effect.gen(function* () {
        const wsOpt = yield* Ref.get(wsRef);
        if (Option.isNone(wsOpt)) {
          return yield* Effect.fail(new SocketClientError({ message: 'SocketClient: Not connected' }));
        }
        const ws = wsOpt.value;
        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
        yield* Effect.try({
          try: () => ws.send(data),
          catch: (e) => new SocketClientError({ message: 'SocketClient: Failed to send message', cause: e }),
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
