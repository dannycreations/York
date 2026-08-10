import { chalk, randomString } from '@vegapunk/utilities';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Context, Data, Effect, identity, Layer, Option, Ref, Schema, Stream } from 'effect';

import { Twitch } from '../core/Constants.js';
import { SocketMessageSchema } from '../core/Schemas.js';
import { HttpClientTag } from '../structures/HttpClient.js';
import { makeSocketClient } from '../structures/SocketClient.js';

import type { SocketMessage } from '../core/Schemas.js';

export class TwitchSocketError extends Data.TaggedError('TwitchSocketError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TwitchSocket {
  readonly listen: (topics: ReadonlyArray<string>, id: string) => Effect.Effect<void, TwitchSocketError>;
  readonly unlisten: (topics: ReadonlyArray<string>, id: string) => Effect.Effect<void, TwitchSocketError>;
  readonly messages: Stream.Stream<SocketMessage, never, never>;
  readonly disconnect: Effect.Effect<void>;
}

export class TwitchSocketTag extends Context.Tag('@services/TwitchSocket')<TwitchSocketTag, TwitchSocket>() {}

export const TwitchSocketLayer = (authToken: string): Layer.Layer<TwitchSocketTag, TwitchSocketError, HttpClientTag> =>
  Layer.scoped(
    TwitchSocketTag,
    Effect.gen(function* () {
      const client = yield* makeSocketClient({
        url: Twitch.WssUrl,
        pingIntervalMs: 180_000,
        pingTimeoutMs: 10_000,
        pingPayload: { type: 'PING' },
        reconnectBaseMs: 1_000,
        reconnectMaxMs: 60_000,
        reconnectMaxAttempts: Infinity,
      }).pipe(Effect.mapError((e) => new TwitchSocketError({ message: 'TwitchSocket: Failed to initialize client', cause: e })));

      const subscribedTopics = yield* Ref.make<ReadonlySet<string>>(new Set());

      const performTopics = (type: 'LISTEN' | 'UNLISTEN', topicKeys: ReadonlyArray<string>): Effect.Effect<void, TwitchSocketError> =>
        client
          .send({
            type,
            nonce: randomString(30),
            data: {
              topics: topicKeys,
              auth_token: authToken,
            },
          })
          .pipe(
            Effect.tap(() => Effect.logDebug(`TwitchSocket: ${type} ${topicKeys.join(', ')}`)),
            Effect.mapError((e) => new TwitchSocketError({ message: `TwitchSocket: Failed to ${type} ${topicKeys.join(', ')}`, cause: e })),
          );

      const toTopicKeys = (topics: ReadonlyArray<string>, id: string): ReadonlyArray<string> => [...new Set(topics.map((topic) => `${topic}.${id}`))];

      const listen = (topics: ReadonlyArray<string>, id: string): Effect.Effect<void, TwitchSocketError> =>
        Ref.modify(subscribedTopics, (s) => {
          const pending = toTopicKeys(topics, id).filter((topicKey) => !s.has(topicKey));

          if (pending.length === 0) {
            return [Effect.void, s];
          }

          const listenEffect = performTopics('LISTEN', pending).pipe(
            Effect.catchAll((e) =>
              Ref.update(subscribedTopics, (set) => {
                const next = new Set(set);
                for (const topicKey of pending) {
                  next.delete(topicKey);
                }
                return next;
              }).pipe(Effect.zipRight(Effect.fail(e))),
            ),
          );

          return [listenEffect, new Set([...s, ...pending])];
        }).pipe(Effect.flatten);

      const unlisten = (topics: ReadonlyArray<string>, id: string): Effect.Effect<void, TwitchSocketError> =>
        Ref.modify(subscribedTopics, (s) => {
          const pending = toTopicKeys(topics, id).filter((topicKey) => s.has(topicKey));

          if (pending.length === 0) {
            return [Effect.void, s];
          }

          const next = new Set(s);
          for (const topicKey of pending) {
            next.delete(topicKey);
          }

          return [performTopics('UNLISTEN', pending), next];
        }).pipe(Effect.flatten);

      const parseMessage = (data: string): Effect.Effect<Option.Option<SocketMessage>> =>
        Effect.gen(function* () {
          const raw = yield* Effect.try({
            try: () => JSON.parse(data),
            catch: () => undefined,
          }).pipe(Effect.orDie);

          if (
            !isObjectLike<{
              readonly type: string;
              readonly data: { readonly topic: string; readonly message: string };
            }>(raw) ||
            raw.type !== 'MESSAGE' ||
            typeof raw.data.topic !== 'string' ||
            typeof raw.data.message !== 'string'
          ) {
            return Option.none();
          }

          const { topic, message } = raw.data;
          const [topicType, topicId] = topic.split('.');

          const value = yield* Effect.try({
            try: () => JSON.parse(message),
            catch: () => undefined,
          }).pipe(Effect.orDie);

          if (!isObjectLike<{ readonly topic_id: unknown }>(value)) {
            return Option.none();
          }

          const topic_id = typeof value.topic_id === 'string' ? value.topic_id : topicId;

          const payload = {
            topicType,
            topicId,
            payload: { ...value, topic_id },
          };

          yield* Effect.logDebug(chalk`TwitchSocket: Emitted ${topicType}.${topicId}`, payload);

          return yield* Schema.decodeUnknown(SocketMessageSchema)(payload).pipe(
            Effect.map(Option.some),
            Effect.orElseSucceed(() => Option.none()),
          );
        });

      const messages: Stream.Stream<SocketMessage, never, never> = client.events.pipe(
        Stream.filterMap((event) => (event._tag === 'Message' ? Option.some(event.data) : Option.none())),
        Stream.mapEffect(parseMessage),
        Stream.filterMap(identity),
      );

      yield* client.events.pipe(
        Stream.filter((e) => e._tag === 'Open'),
        Stream.tap(() =>
          Effect.gen(function* () {
            const topics = yield* Ref.get(subscribedTopics);

            if (topics.size === 0) {
              return;
            }

            yield* Effect.logInfo(`TwitchSocket: Reconnected, resubscribing to ${topics.size} topics`);
            yield* performTopics('LISTEN', [...topics]).pipe(Effect.ignore);
          }),
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );

      return {
        listen,
        unlisten,
        messages,
        disconnect: client.disconnect(),
      } satisfies TwitchSocket;
    }),
  );
