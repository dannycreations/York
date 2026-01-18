import { chalk, randomString } from '@vegapunk/utilities';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Layer, Option, Ref, Schema, Stream } from 'effect';

import { Twitch } from '../core/Constants';
import { SocketMessageSchema } from '../core/Schemas';
import { makeSocketClient } from '../structures/SocketClient';

import type { SocketMessage } from '../core/Schemas';
import type { HttpClient } from '../structures/HttpClient';

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

export const TwitchSocketTag = Context.GenericTag<TwitchSocket>('@services/TwitchSocket');

export const TwitchSocketLayer = (authToken: string): Layer.Layer<TwitchSocket, TwitchSocketError, HttpClient> =>
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

      const parseMessage = (data: string): Effect.Effect<Option.Option<unknown>> =>
        Effect.try({
          try: () => JSON.parse(data),
          catch: (e) => new TwitchSocketError({ message: 'TwitchSocket: Failed to parse raw message', cause: e }),
        }).pipe(Effect.option);

      const handleReconnect = (raw: unknown): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (isObjectLike<{ type: string }>(raw) && raw.type === 'RECONNECT') {
            yield* Effect.logWarning('TwitchSocket: Received RECONNECT instruction from server');
            yield* client.disconnect(false);
            yield* client.connect.pipe(Effect.ignore);
          }
        });

      const extractPayload = (raw: unknown): Effect.Effect<Option.Option<unknown>, never, never> =>
        Effect.gen(function* () {
          if (!isObjectLike<{ type: string; data: unknown }>(raw) || raw.type !== 'MESSAGE') {
            return Option.none();
          }

          const { data } = raw;
          if (!isObjectLike<{ topic: string; message: string }>(data) || typeof data.topic !== 'string' || typeof data.message !== 'string') {
            return Option.none();
          }

          const [topicType, topicId] = data.topic.split('.');
          return yield* parseMessage(data.message).pipe(
            Effect.map(
              Option.flatMap((value) =>
                isObjectLike<{ data: unknown; topic_id: unknown }>(value)
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
              ),
            ),
          );
        });

      const messages: Stream.Stream<SocketMessage, never, never> = client.events.pipe(
        Stream.filterMap((event) => (event._tag === 'Message' ? Option.some(event.data) : Option.none())),
        Stream.mapEffect(parseMessage),
        Stream.filterMap((o) => o),
        Stream.tap(handleReconnect),
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
