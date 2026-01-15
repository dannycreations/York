import { WebSocket } from '@vegapunk/struct';
import { randomString } from '@vegapunk/utilities';
import { Context, Data, Effect, Layer, PubSub, Ref, Runtime, Stream } from 'effect';

export class TwitchSocketError extends Data.TaggedError('TwitchSocketError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TwitchSocket {
  readonly listen: (topic: string, id: string) => Effect.Effect<void, TwitchSocketError>;
  readonly unlisten: (topic: string, id: string) => Effect.Effect<void, TwitchSocketError>;
  readonly messages: Stream.Stream<any, never, never>;
}

export class TwitchSocketTag extends Context.Tag('@services/TwitchSocket')<TwitchSocketTag, TwitchSocket>() {}

export const TwitchSocketLayer = (authToken: string) =>
  Layer.scoped(
    TwitchSocketTag,
    Effect.gen(function* () {
      const messagesPubSub = yield* PubSub.unbounded<any>();
      const subscribedTopics = yield* Ref.make<ReadonlySet<string>>(new Set());
      const runtime = yield* Effect.runtime<never>();
      const runPromise = Runtime.runPromise(runtime);

      class TwitchWebSocket extends WebSocket<any> {
        protected override async onOpen(): Promise<void> {
          const topics = await runPromise(Ref.get(subscribedTopics));
          for (const topicKey of topics) {
            const [topic, id] = topicKey.split('.');
            await runPromise(listen(topic, id));
          }
        }
        protected override onClose(): void {}
        protected override onError(): void {}
        protected override async onPing(): Promise<void> {
          await this.sendRequest({
            description: 'ping',
            payload: JSON.stringify({ type: 'PING' }),
          });
        }
        protected override onMaxReconnects(): void {}
        protected override onMessage(data: Buffer): void {
          try {
            const message = JSON.parse(data.toString('utf8'));
            if (message.type === 'MESSAGE') {
              const eventData = message.data;
              const content = JSON.parse(eventData.message);
              const [topicType, topicId] = eventData.topic.split('.');
              messagesPubSub.unsafeOffer({ topicType, topicId, ...content });
            } else if (message.type === 'RECONNECT') {
              this.disconnect(false);
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }

      const ws = new TwitchWebSocket({
        authToken,
        url: 'wss://pubsub-edge.twitch.tv/v1',
        autoConnect: false,
        pingIntervalMs: 180_000,
        requestTimeoutMs: 10_000,
      });

      yield* Effect.addFinalizer(() => Effect.sync(() => ws.dispose()));

      yield* Effect.tryPromise({
        try: () => ws.connect() as unknown as Promise<void>,
        catch: (e) => new TwitchSocketError({ message: 'Failed to connect', cause: e }),
      });

      const listen = (topic: string, id: string) =>
        Effect.gen(function* () {
          const topicKey = `${topic}.${id}`;
          yield* Ref.update(subscribedTopics, (s) => new Set([...s, topicKey]));
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

      const unlisten = (topic: string, id: string) =>
        Effect.gen(function* () {
          const topicKey = `${topic}.${id}`;
          yield* Ref.update(subscribedTopics, (s) => {
            const next = new Set(s);
            next.delete(topicKey);
            return next;
          });
          yield* Effect.tryPromise({
            try: () =>
              ws.sendRequest({
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
        });

      return {
        listen,
        unlisten,
        messages: Stream.fromPubSub(messagesPubSub),
      };
    }),
  );
