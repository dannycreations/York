import { chalk, randomString } from '@vegapunk/utilities';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Context, Data, Effect, identity, Layer, Option, Ref, Schema, Stream } from 'effect';

import { Twitch } from '../core/Constants';
import { SocketMessageSchema } from '../core/Schemas';
import { HttpClientTag } from '../structures/HttpClient';
import { makeSocketClient } from '../structures/SocketClient';

import type { SocketMessage } from '../core/Schemas';

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
        Ref.modify(subscribedTopics, (s) => {
          const topicKey = `${topic}.${id}`;
          const alreadySubscribed = s.has(topicKey);

          if (alreadySubscribed) {
            return [Effect.void, s];
          }

          const listenEffect = performListen(topicKey).pipe(
            Effect.tap(() => Effect.logDebug(`TwitchSocket: Subscribed ${topicKey}`)),
            Effect.catchAll((e) =>
              Ref.update(subscribedTopics, (set) => {
                const next = new Set(set);
                next.delete(topicKey);
                return next;
              }).pipe(Effect.zipRight(Effect.fail(e))),
            ),
          );

          return [listenEffect, new Set([...s, topicKey])];
        }).pipe(Effect.flatten);

      const unlisten = (topic: string, id: string): Effect.Effect<void, TwitchSocketError> =>
        Ref.modify(subscribedTopics, (s) => {
          const topicKey = `${topic}.${id}`;
          const isSubscribed = s.has(topicKey);

          if (!isSubscribed) {
            return [Effect.void, s];
          }

          const next = new Set(s);
          next.delete(topicKey);

          const unlistenEffect = performUnlisten(topicKey).pipe(Effect.tap(() => Effect.logDebug(`TwitchSocket: Unsubscribed ${topicKey}`)));

          return [unlistenEffect, next];
        }).pipe(Effect.flatten);

      const messages: Stream.Stream<SocketMessage, never, never> = Stream.filterMap(client.events, (event) => {
        if (event._tag !== 'Message') {
          return Option.none();
        }

        return Option.some(event.data);
      }).pipe(
        Stream.mapEffect((data) =>
          Effect.gen(function* () {
            const raw = yield* Effect.try({
              try: () => JSON.parse(data),
              catch: () => undefined,
            }).pipe(Effect.orDie);

            const isRawValid = isObjectLike<{
              readonly type: string;
              readonly data: { readonly topic: string; readonly message: string };
            }>(raw);

            if (!isRawValid) {
              return Option.none();
            }

            if (raw.type !== 'MESSAGE') {
              return Option.none();
            }

            if (typeof raw.data.topic !== 'string') {
              return Option.none();
            }

            if (typeof raw.data.message !== 'string') {
              return Option.none();
            }

            const { topic, message } = raw.data;
            const [topicType, topicId] = topic.split('.');

            const value = yield* Effect.try({
              try: () => JSON.parse(message),
              catch: () => undefined,
            }).pipe(Effect.orDie);

            const isValueValid = isObjectLike<{ readonly data: unknown; readonly topic_id: unknown }>(value);

            if (!isValueValid) {
              return Option.none();
            }

            const payloadData = isObjectLike(value.data) ? value.data : {};

            let topic_id = topicId;

            if (typeof value.topic_id === 'string') {
              topic_id = value.topic_id;
            }

            const payload = {
              topicType,
              topicId,
              payload: {
                ...value,
                ...payloadData,
                topic_id,
              },
            };

            yield* Effect.logDebug(chalk`TwitchSocket: Emitted ${topicType}.${topicId}`, payload);

            const decodeResult = yield* Schema.decodeUnknown(SocketMessageSchema)(payload).pipe(
              Effect.map(Option.some),
              Effect.catchAll(() => Effect.succeed(Option.none())),
            );

            return decodeResult;
          }),
        ),
        Stream.filterMap(identity),
      );

      yield* client.events.pipe(
        Stream.filter((e) => e._tag === 'Open'),
        Stream.runForEach(() =>
          Effect.gen(function* () {
            const topics = yield* Ref.get(subscribedTopics);
            const hasNoTopics = topics.size === 0;

            if (hasNoTopics) {
              return;
            }

            yield* Effect.logInfo(`TwitchSocket: Reconnected, resubscribing to ${topics.size} topics`);
            yield* Effect.forEach(topics, (topicKey) => performListen(topicKey), { discard: true });
          }),
        ),
        Effect.forkScoped,
      );

      return {
        listen,
        unlisten,
        messages,
        disconnect: (graceful) => client.disconnect(graceful),
      } satisfies TwitchSocket;
    }),
  );
