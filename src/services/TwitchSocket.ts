import { chalk, randomString } from '@vegapunk/utilities';
import { Context, Data, Effect, Layer, Option, Ref, Schema, Stream } from 'effect';

import { SocketMessageSchema } from '../core/Schemas';
import { createSocketClient } from '../structures/SocketClient';

import type { SocketMessage } from '../core/Schemas';

export type { SocketMessage };

export class TwitchSocketError extends Data.TaggedError('TwitchSocketError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TwitchSocket {
  readonly listen: (topic: string, id: string) => Effect.Effect<void, TwitchSocketError>;
  readonly unlisten: (topic: string, id: string) => Effect.Effect<void, TwitchSocketError>;
  readonly messages: Stream.Stream<SocketMessage, never, never>;
  readonly disconnect: (graceful?: boolean) => Effect.Effect<void>;
}

export class TwitchSocketTag extends Context.Tag('@services/TwitchSocket')<TwitchSocketTag, TwitchSocket>() {}

export const TwitchSocketLayer = (authToken: string): Layer.Layer<TwitchSocketTag, TwitchSocketError, never> =>
  Layer.scoped(
    TwitchSocketTag,
    Effect.gen(function* () {
      const client = yield* createSocketClient({
        url: 'wss://pubsub-edge.twitch.tv/v1',
        pingIntervalMs: 180_000,
        pingTimeoutMs: 10_000,
        pingPayload: { type: 'PING' },
        reconnectBaseMs: 1_000,
        reconnectMaxMs: 60_000,
        reconnectMaxAttempts: Infinity,
      }).pipe(Effect.mapError((e) => new TwitchSocketError({ message: 'TwitchSocket: Failed to initialize client', cause: e })));

      const subscribedTopics = yield* Ref.make<ReadonlySet<string>>(new Set());

      const performListen = (topicKey: string): Effect.Effect<void, TwitchSocketError> =>
        client
          .send({
            type: 'LISTEN',
            nonce: randomString(30),
            data: {
              topics: [topicKey],
              auth_token: authToken,
            },
          })
          .pipe(Effect.mapError((e) => new TwitchSocketError({ message: `TwitchSocket: Failed to listen to ${topicKey}`, cause: e })));

      const performUnlisten = (topicKey: string): Effect.Effect<void, TwitchSocketError> =>
        client
          .send({
            type: 'UNLISTEN',
            nonce: randomString(30),
            data: {
              topics: [topicKey],
              auth_token: authToken,
            },
          })
          .pipe(Effect.mapError((e) => new TwitchSocketError({ message: `TwitchSocket: Failed to unlisten from ${topicKey}`, cause: e })));

      const listen = (topic: string, id: string): Effect.Effect<void, TwitchSocketError> =>
        Effect.gen(function* () {
          const topicKey = `${topic}.${id}`;
          const current = yield* Ref.get(subscribedTopics);
          if (current.has(topicKey)) return;

          yield* Ref.update(subscribedTopics, (s) => new Set([...s, topicKey]));
          yield* performListen(topicKey);
          yield* Effect.logDebug(`AppSocket: Subscribed ${topicKey}`);
        });

      const unlisten = (topic: string, id: string): Effect.Effect<void, TwitchSocketError> =>
        Effect.gen(function* () {
          const topicKey = `${topic}.${id}`;
          const current = yield* Ref.get(subscribedTopics);
          if (!current.has(topicKey)) return;

          yield* Ref.update(subscribedTopics, (s) => {
            const next = new Set(s);
            next.delete(topicKey);
            return next;
          });
          yield* performUnlisten(topicKey);
          yield* Effect.logDebug(`AppSocket: Unsubscribed ${topicKey}`);
        });

      const messages: Stream.Stream<SocketMessage, never, never> = client.events.pipe(
        Stream.filterMap((event) => (event._tag === 'Message' ? Option.some(event.data) : Option.none())),
        Stream.mapEffect((data) =>
          Effect.try({
            try: () => JSON.parse(data) as unknown,
            catch: (e) => new TwitchSocketError({ message: 'TwitchSocket: Failed to parse raw message', cause: e }),
          }).pipe(Effect.option),
        ),
        Stream.filterMap((o) => o),
        Stream.tap((raw) =>
          raw && typeof raw === 'object' && 'type' in raw && raw.type === 'RECONNECT'
            ? Effect.gen(function* () {
                yield* Effect.logWarning('TwitchSocket: Received RECONNECT instruction from server');
                yield* client.disconnect(false);
                yield* client.connect.pipe(Effect.ignore);
              })
            : Effect.void,
        ),
        Stream.mapEffect((raw) =>
          Effect.gen(function* () {
            const isMessage =
              raw &&
              typeof raw === 'object' &&
              'type' in raw &&
              raw.type === 'MESSAGE' &&
              'data' in raw &&
              typeof raw.data === 'object' &&
              raw.data &&
              'topic' in raw.data &&
              typeof raw.data.topic === 'string' &&
              'message' in raw.data &&
              typeof raw.data.message === 'string';

            if (!isMessage) return Option.none();

            const data = raw.data as { topic: string; message: string };
            const [topicType, topicId] = data.topic.split('.');

            const content = yield* Effect.try({
              try: () => JSON.parse(data.message) as unknown,
              catch: (e) => new TwitchSocketError({ message: 'TwitchSocket: Failed to parse message content', cause: e }),
            }).pipe(Effect.option);

            if (Option.isNone(content) || !content.value || typeof content.value !== 'object') {
              return Option.none();
            }

            const payload = content.value as Record<string, unknown>;
            const innerData = 'data' in payload && payload.data && typeof payload.data === 'object' ? (payload.data as Record<string, unknown>) : {};

            return Option.some({
              topicType,
              topicId,
              payload: {
                ...payload,
                ...innerData,
                topic_id: ('topic_id' in payload && typeof payload.topic_id === 'string' ? payload.topic_id : undefined) ?? topicId,
              },
            });
          }),
        ),
        Stream.filterMap((o) => o),
        Stream.tap((payload) => Effect.logDebug(chalk`AppSocket: Emitted ${payload.topicType}.${payload.topicId}`, payload.payload)),
        Stream.mapEffect((payload) =>
          Schema.decodeUnknown(SocketMessageSchema)(payload).pipe(
            Effect.map(Option.some),
            Effect.catchAll(() => Effect.succeed(Option.none())),
          ),
        ),
        Stream.filterMap((o) => o),
      );

      // Re-subscribe on reconnect
      yield* client.events.pipe(
        Stream.filter((e) => e._tag === 'Open'),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const topics = yield* Ref.get(subscribedTopics);
            if (topics.size === 0) return;
            yield* Effect.logInfo(`TwitchSocket: Reconnected, resubscribing to ${topics.size} topics`);
            yield* Effect.forEach(topics, (topicKey) => performListen(topicKey), { discard: true });
          }),
        ),
        Effect.fork,
      );

      return {
        listen,
        unlisten,
        messages,
        disconnect: (graceful) => client.disconnect(graceful),
      } satisfies TwitchSocket;
    }),
  );
