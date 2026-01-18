import { chalk, randomString } from '@vegapunk/utilities';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Layer, Option, Ref, Schema, Stream } from 'effect';

import { Twitch } from '../core/Constants';
import { SocketMessageSchema } from '../core/Schemas';
import { HttpClientTag } from '../structures/HttpClient';
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

export const TwitchSocketLayer = (authToken: string): Layer.Layer<TwitchSocketTag, TwitchSocketError, HttpClientTag> =>
  Layer.scoped(
    TwitchSocketTag,
    Effect.gen(function* () {
      const client = yield* createSocketClient({
        url: Twitch.WssUrl,
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
          yield* Effect.logDebug(`TwitchSocket: Subscribed ${topicKey}`);
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
          yield* Effect.logDebug(`TwitchSocket: Unsubscribed ${topicKey}`);
        });

      const messages: Stream.Stream<SocketMessage, never, never> = client.events.pipe(
        Stream.filterMap((event) => (event._tag === 'Message' ? Option.some(event.data) : Option.none())),
        Stream.mapEffect((data) =>
          Effect.try({
            try: () => JSON.parse(data),
            catch: (e) => new TwitchSocketError({ message: 'TwitchSocket: Failed to parse raw message', cause: e }),
          }).pipe(Effect.option),
        ),
        Stream.filterMap((o) => o),
        Stream.tap((raw) =>
          isObjectLike(raw) && raw.type === 'RECONNECT'
            ? Effect.gen(function* () {
                yield* Effect.logWarning('TwitchSocket: Received RECONNECT instruction from server');
                yield* client.disconnect(false);
                yield* client.connect.pipe(Effect.ignore);
              })
            : Effect.void,
        ),
        Stream.mapEffect((raw) =>
          Effect.gen(function* () {
            if (!isObjectLike(raw) || raw.type !== 'MESSAGE') return Option.none();

            const data = isObjectLike(raw.data) ? raw.data : null;
            if (!data) return Option.none();

            const topic = typeof data.topic === 'string' ? data.topic : null;
            const message = typeof data.message === 'string' ? data.message : null;
            if (!topic || !message) return Option.none();

            const [topicType, topicId] = topic.split('.');

            const content = yield* Effect.try({
              try: () => JSON.parse(message),
              catch: (e) => new TwitchSocketError({ message: 'TwitchSocket: Failed to parse message content', cause: e }),
            }).pipe(Effect.option);

            return Option.match(content, {
              onNone: () => Option.none(),
              onSome: (value) => {
                if (!isObjectLike(value)) return Option.none();

                const innerData = isObjectLike(value.data) ? value.data : {};
                const topic_id = (typeof value.topic_id === 'string' ? value.topic_id : undefined) ?? topicId;
                return Option.some({
                  topicType,
                  topicId,
                  payload: {
                    ...value,
                    ...innerData,
                    topic_id,
                  },
                });
              },
            });
          }),
        ),
        Stream.filterMap((o) => o),
        Stream.tap((payload) => Effect.logDebug(chalk`TwitchSocket: Emitted ${payload.topicType}.${payload.topicId}`, payload.payload)),
        Stream.mapEffect((payload) =>
          Schema.decodeUnknown(SocketMessageSchema)(payload).pipe(
            Effect.map(Option.some),
            Effect.catchAll(() => Effect.succeed(Option.none())),
          ),
        ),
        Stream.filterMap((o) => o),
      );

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
