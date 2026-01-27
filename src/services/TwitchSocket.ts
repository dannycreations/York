import { chalk, randomString } from '@vegapunk/utilities';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Layer, Option, Ref, Schema, Stream } from 'effect';

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
          if (s.has(topicKey)) return [Effect.void, s];
          return [
            performListen(topicKey).pipe(
              Effect.tap(() => Effect.logDebug(`TwitchSocket: Subscribed ${topicKey}`)),
              Effect.catchAll((e) =>
                Ref.update(subscribedTopics, (set) => {
                  const next = new Set(set);
                  next.delete(topicKey);
                  return next;
                }).pipe(Effect.zipRight(Effect.fail(e))),
              ),
            ),
            new Set([...s, topicKey]),
          ];
        }).pipe(Effect.flatten);

      const unlisten = (topic: string, id: string): Effect.Effect<void, TwitchSocketError> =>
        Ref.modify(subscribedTopics, (s) => {
          const topicKey = `${topic}.${id}`;
          if (!s.has(topicKey)) return [Effect.void, s];
          const next = new Set(s);
          next.delete(topicKey);
          return [performUnlisten(topicKey).pipe(Effect.tap(() => Effect.logDebug(`TwitchSocket: Unsubscribed ${topicKey}`))), next];
        }).pipe(Effect.flatten);

      const parseMessage = (data: string): Effect.Effect<Option.Option<unknown>> =>
        Effect.try({
          try: () => JSON.parse(data),
          catch: (e) => new TwitchSocketError({ message: 'TwitchSocket: Failed to parse raw message', cause: e }),
        }).pipe(Effect.option);

      const extractPayload = (raw: unknown): Effect.Effect<Option.Option<unknown>> =>
        Effect.gen(function* () {
          if (!isObjectLike<{ readonly type: string; readonly data: unknown }>(raw) || raw.type !== 'MESSAGE') {
            return Option.none();
          }

          const { data } = raw;
          if (
            !isObjectLike<{ readonly topic: string; readonly message: string }>(data) ||
            typeof data.topic !== 'string' ||
            typeof data.message !== 'string'
          ) {
            return Option.none();
          }

          const [topicType, topicId] = data.topic.split('.');
          const messageOpt = yield* parseMessage(data.message);

          return Option.flatMap(messageOpt, (value) =>
            isObjectLike<{ readonly data: unknown; readonly topic_id: unknown }>(value)
              ? Option.some({
                  topicType,
                  topicId,
                  payload: {
                    ...value,
                    ...(isObjectLike(value.data) ? value.data : {}),
                    topic_id: typeof value.topic_id === 'string' ? value.topic_id : topicId,
                  },
                })
              : Option.none(),
          );
        });

      const messages: Stream.Stream<SocketMessage, never, never> = client.events.pipe(
        Stream.filterMap((event) => (event._tag === 'Message' ? Option.some(event.data) : Option.none())),
        Stream.mapEffect(parseMessage),
        Stream.filterMap((o) => o),
        Stream.mapEffect(extractPayload),
        Stream.filterMap((o) => o),
        Stream.tap((payload) =>
          isObjectLike<{ topicType: unknown; topicId: unknown }>(payload) && 'topicType' in payload && 'topicId' in payload
            ? Effect.logDebug(chalk`TwitchSocket: Emitted ${String(payload.topicType)}.${String(payload.topicId)}`, payload)
            : Effect.void,
        ),
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
        Effect.annotateLogs({ service: 'TwitchSocket', operation: 'resubscribe' }),
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
