import { WebSocket } from '@vegapunk/struct';
import { chalk, randomString } from '@vegapunk/utilities';
import { Context, Data, Effect, Layer, PubSub, Ref, Runtime, Schema, Stream } from 'effect';

export const SocketMessageSchema = Schema.Struct({
  topicType: Schema.String,
  topicId: Schema.String,
  type: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
  channel_id: Schema.optional(Schema.String),
  game: Schema.optional(Schema.String),
  game_id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  moment_id: Schema.optional(Schema.String),
  drop_id: Schema.optional(Schema.String),
  drop_instance_id: Schema.optional(Schema.String),
  current_progress_min: Schema.optional(Schema.Number),
  claim: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      channel_id: Schema.String,
    }),
  ),
});

export type SocketMessage = Schema.Schema.Type<typeof SocketMessageSchema>;

export class TwitchSocketError extends Data.TaggedError('TwitchSocketError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TwitchSocket {
  readonly listen: (topic: string, id: string) => Effect.Effect<void, TwitchSocketError>;
  readonly unlisten: (topic: string, id: string) => Effect.Effect<void, TwitchSocketError>;
  readonly messages: Stream.Stream<SocketMessage, never, never>;
  readonly disconnect: (reconnect?: boolean) => Effect.Effect<void>;
}

export class TwitchSocketTag extends Context.Tag('@services/TwitchSocket')<TwitchSocketTag, TwitchSocket>() {}

export const TwitchSocketLayer = (authToken: string): Layer.Layer<TwitchSocketTag, TwitchSocketError, never> =>
  Layer.scoped(
    TwitchSocketTag,
    Effect.gen(function* () {
      const messagesPubSub = yield* PubSub.unbounded<SocketMessage>();
      const subscribedTopics = yield* Ref.make<ReadonlySet<string>>(new Set());
      const wsRef = yield* Ref.make<WebSocket<object> | undefined>(undefined);
      const isConnecting = yield* Ref.make(false);
      const lastPongReceivedAt = yield* Ref.make(Date.now());

      const performListen = (ws: WebSocket<object>, topic: string, id: string, updateRef: boolean) =>
        Effect.gen(function* () {
          const topicKey = `${topic}.${id}`;
          if (updateRef) {
            yield* Ref.update(subscribedTopics, (s) => new Set([...s, topicKey]));
          }
          yield* Effect.tryPromise({
            try: () =>
              ws.sendRequest({
                description: `listen ${topicKey}`,
                payload: JSON.stringify({
                  type: 'LISTEN',
                  nonce: randomString(30),
                  data: {
                    topics: [topicKey],
                    auth_token: authToken,
                  },
                }),
              }),
            catch: (e) => new TwitchSocketError({ message: 'Failed to listen', cause: e }),
          });
        });

      const onOpen = (ws: WebSocket<object>) =>
        Effect.gen(function* () {
          yield* Ref.set(lastPongReceivedAt, Date.now());
          const topics = yield* Ref.get(subscribedTopics);
          yield* Effect.forEach(topics, (topicKey) => {
            const [topic, id] = topicKey.split('.');
            return performListen(ws, topic, id, false);
          });
        });

      const onMessage = (data: Buffer) =>
        Effect.gen(function* () {
          const messageResult = yield* Schema.decodeUnknown(
            Schema.Struct({
              type: Schema.optional(Schema.String),
              data: Schema.optional(Schema.Unknown),
              error: Schema.optional(Schema.String),
              nonce: Schema.optional(Schema.String),
            }),
          )(JSON.parse(data.toString('utf8'))).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

          if (!messageResult) {
            return;
          }

          if (messageResult.type === 'PONG') {
            yield* Ref.set(lastPongReceivedAt, Date.now());
            yield* Effect.logDebug('TwitchSocket: PONG received');
            return;
          }

          if (messageResult.type === 'RESPONSE') {
            if (messageResult.error && messageResult.error !== '') {
              yield* Effect.logWarning(chalk`{yellow TwitchSocket: Received RESPONSE with error: ${messageResult.error}}`);
            }
            return;
          }

          if (messageResult.type === 'RECONNECT') {
            yield* Effect.logInfo('AppSocket: Received RECONNECT instruction from server');
            const socket = yield* Ref.get(wsRef);
            if (socket) {
              yield* Effect.sync(() => socket.disconnect(false));
            }
            return;
          }

          if (messageResult.type === 'MESSAGE') {
            const eventData = messageResult.data;
            if (!eventData || typeof eventData !== 'object' || !('message' in eventData) || typeof eventData.message !== 'string') {
              return;
            }

            const content = yield* Schema.decodeUnknown(
              Schema.Struct({
                data: Schema.optional(Schema.Unknown),
                topic_id: Schema.optional(Schema.String),
              }),
            )(JSON.parse(eventData.message as string)).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

            if (!content) {
              return yield* Effect.void;
            }

            if (typeof eventData !== 'object' || !('topic' in eventData) || typeof eventData.topic !== 'string') {
              return;
            }

            const [topicType, topicId] = eventData.topic.split('.');
            const payload = {
              topicType,
              topicId,
              ...content,
              ...(content.data && typeof content.data === 'object' ? content.data : {}),
              topic_id: content.topic_id ?? topicId,
            };

            const decoded = yield* Schema.decodeUnknown(SocketMessageSchema)(payload).pipe(Effect.orDie);
            yield* PubSub.publish(messagesPubSub, decoded);
          }
        });

      const runtime = yield* Effect.runtime<never>();
      const runFork = Runtime.runFork(runtime);

      const ws = new (class extends WebSocket<object> {
        protected override onOpen(): void {
          runFork(onOpen(this));
        }
        protected override onClose(): void {}
        protected override onError(): void {}
        protected override onPing(): void {
          runFork(
            Effect.gen(function* () {
              const lastPong = yield* Ref.get(lastPongReceivedAt);
              const pongDeadline = lastPong + 180_000 + 10_000;
              if (Date.now() > pongDeadline) {
                yield* Effect.logWarning('TwitchSocket: Ping health check failed. Forcing reconnect');
                ws.disconnect(false);
                return;
              }

              yield* Effect.tryPromise({
                try: () =>
                  ws.sendRequest({
                    description: 'ping',
                    payload: JSON.stringify({ type: 'PING' }),
                  }),
                catch: () => undefined,
              });
              yield* Effect.logDebug('TwitchSocket: PING sent');
            }),
          );
        }
        protected override onMaxReconnects(): void {}
        protected override onMessage(data: Buffer): void {
          runFork(onMessage(data));
        }
      })({
        url: 'wss://pubsub-edge.twitch.tv/v1',
        autoConnect: false,
        pingIntervalMs: 180_000,
        requestTimeoutMs: 10_000,
      });

      yield* Ref.set(wsRef, ws);
      yield* Effect.addFinalizer(() => Effect.sync(() => ws.dispose()));

      const connect = Effect.gen(function* () {
        if (yield* Ref.get(isConnecting)) {
          return;
        }
        yield* Ref.set(isConnecting, true);
        yield* Effect.logDebug('TwitchSocket: Connecting to PubSub...');
        yield* Effect.tryPromise({
          try: () => Promise.resolve(ws.connect()),
          catch: (e) => new TwitchSocketError({ message: 'Failed to connect', cause: e }),
        }).pipe(Effect.ensuring(Ref.set(isConnecting, false)));
      });

      yield* connect;

      const listen = (topic: string, id: string) =>
        Effect.gen(function* () {
          const topicKey = `${topic}.${id}`;
          const current = yield* Ref.get(subscribedTopics);
          if (current.has(topicKey)) {
            return;
          }
          const socket = yield* Ref.get(wsRef);
          if (socket) {
            yield* performListen(socket, topic, id, true);
          }
        });

      const unlisten = (topic: string, id: string) =>
        Effect.gen(function* () {
          const topicKey = `${topic}.${id}`;
          const current = yield* Ref.get(subscribedTopics);
          if (!current.has(topicKey)) {
            return;
          }

          yield* Ref.update(subscribedTopics, (s) => {
            const next = new Set(s);
            next.delete(topicKey);
            return next;
          });

          const socket = yield* Ref.get(wsRef);
          if (socket) {
            yield* Effect.tryPromise({
              try: () =>
                socket.sendRequest({
                  description: `unlisten ${topicKey}`,
                  payload: JSON.stringify({
                    type: 'UNLISTEN',
                    nonce: randomString(30),
                    data: {
                      topics: [topicKey],
                      auth_token: authToken,
                    },
                  }),
                }),
              catch: (e) => new TwitchSocketError({ message: 'Failed to unlisten', cause: e }),
            });
          }
        });

      const disconnect = (reconnect: boolean = false) =>
        Effect.gen(function* () {
          const socket = yield* Ref.get(wsRef);
          if (socket) {
            yield* Effect.sync(() => socket.disconnect(reconnect));
          }
        });

      return {
        listen,
        unlisten,
        messages: Stream.fromPubSub(messagesPubSub),
        disconnect,
      };
    }),
  );
