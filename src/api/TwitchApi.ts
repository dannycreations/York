import { chalk } from '@vegapunk/utilities';
import { Context, Data, Deferred, Effect, Layer, Ref, Schedule, Schema } from 'effect';
import UserAgent from 'user-agents';

import { Twitch } from '../core/Constants.js';
import { DebugTag } from '../core/Debug.js';
import {
  ClaimDropsSchema,
  ClaimMomentsSchema,
  ClaimPointsSchema,
  HelixStreamsSchema,
  InventorySchema,
  PlaybackTokenSchema,
  ViewerDropsDashboardSchema,
} from '../core/Schemas.js';
import { HttpClientTag } from '../structures/HttpClient.js';
import { GqlQueries } from './TwitchGql.js';

import type { ReadonlyRecord } from 'effect/Record';
import type { Channel, GqlResponse } from '../core/Schemas.js';
import type { DefaultOptions } from '../structures/HttpClient.js';
import type { GraphqlRequest } from './TwitchGql.js';

export class TwitchApiError extends Data.TaggedError('TwitchApiError')<{
  readonly message: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}> {}

type AnySchema = Schema.Schema<any, any, never>;

type SchemaTypes<T extends ReadonlyArray<AnySchema>> = { -readonly [K in keyof T]: Schema.Schema.Type<T[K]> };

type SchemaType<S extends AnySchema> = Schema.Schema.Type<S>;

export interface TwitchApi {
  readonly init: Effect.Effect<void, TwitchApiError>;
  readonly userId: Effect.Effect<string, TwitchApiError>;
  readonly graphql: <A, I>(
    requests: ReadonlyArray<GraphqlRequest>,
    schema: Schema.Schema<A, I, never>,
  ) => Effect.Effect<ReadonlyArray<A>, TwitchApiError>;
  readonly graphqlBatch: <const S extends ReadonlyArray<AnySchema>>(
    requests: ReadonlyArray<GraphqlRequest>,
    schemas: S,
  ) => Effect.Effect<SchemaTypes<S>, TwitchApiError>;
  readonly dropsDashboard: Effect.Effect<SchemaType<typeof ViewerDropsDashboardSchema>, TwitchApiError>;
  readonly inventory: Effect.Effect<SchemaType<typeof InventorySchema>, TwitchApiError>;
  readonly helixStreams: (userIds: readonly string[]) => Effect.Effect<SchemaType<typeof HelixStreamsSchema>, TwitchApiError>;
  readonly claimPoints: (channelID: string, claimID: string) => Effect.Effect<SchemaType<typeof ClaimPointsSchema>, TwitchApiError>;
  readonly claimMoments: (momentID: string) => Effect.Effect<SchemaType<typeof ClaimMomentsSchema>, TwitchApiError>;
  readonly claimDrops: (dropInstanceID: string) => Effect.Effect<SchemaType<typeof ClaimDropsSchema>, TwitchApiError>;
  readonly watch: (channel: Channel) => Effect.Effect<{ readonly success: boolean; readonly hlsUrl?: string }, TwitchApiError>;
}

export class TwitchApiTag extends Context.Tag('@services/TwitchApi')<TwitchApiTag, TwitchApi>() {}

const parseUniqueCookies = (setCookie: readonly string[]): Readonly<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (const cookie of setCookie) {
    const [name, rest] = cookie.split('=', 2);

    if (!rest) {
      continue;
    }

    const value = rest.split(';', 1)[0];

    if (name === 'server_session_id') {
      result['client-session-id'] = value;
    }

    if (name === 'unique_id') {
      result['x-device-id'] = value;
    }
  }
  return result;
};

const RETRYABLE_GQL_ERRORS = new Set(['service unavailable', 'service timeout', 'context deadline exceeded']);

const toGraphqlError = (errors: ReadonlyArray<{ readonly message: string }>, operationName?: string): TwitchApiError => {
  const opPrefix = operationName ? `[${operationName}] ` : '';
  const isRetryable = errors.some((e) => RETRYABLE_GQL_ERRORS.has(e.message.toLowerCase()));

  if (isRetryable) {
    return new TwitchApiError({ message: `${opPrefix}Retryable GraphQL Error`, retryable: true, cause: errors });
  }

  return new TwitchApiError({ message: `${opPrefix}GraphQL Error (${errors[0]?.message ?? 'Unknown error'})`, cause: errors });
};

export const TwitchApiLayer = (authToken: string): Layer.Layer<TwitchApiTag, never, HttpClientTag | DebugTag> =>
  Layer.effect(
    TwitchApiTag,
    Effect.gen(function* () {
      const http = yield* HttpClientTag;
      const debug = yield* DebugTag;
      const userIdDeferred = yield* Deferred.make<string>();
      const userAgent = new UserAgent({ deviceCategory: 'mobile' }).toString();
      const headersRef = yield* Ref.make<Record<string, string>>({
        'user-agent': userAgent,
        authorization: `OAuth ${authToken}`,
        'client-id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',
      });

      const getUserId = Deferred.await(userIdDeferred);

      const request = <T>(
        options: string | DefaultOptions,
      ): Effect.Effect<
        { readonly body: T; readonly statusCode: number; readonly headers: ReadonlyRecord<string, string | string[] | undefined> },
        TwitchApiError
      > =>
        Effect.gen(function* () {
          const commonHeaders = yield* Ref.get(headersRef);
          const isString = typeof options === 'string';
          const payload = isString ? { url: options } : options;
          const headers = payload.headers ? { ...commonHeaders, ...payload.headers } : commonHeaders;

          const response = yield* http.request<T>({
            ...payload,
            headers,
            retry: -1,
          });

          if (response.statusCode === 401) {
            yield* Effect.logFatal(chalk`{red Unauthorized: Invalid OAuth token detected during request}`);
            return yield* Effect.die(new TwitchApiError({ message: 'Unauthorized: Invalid OAuth token detected during request' }));
          }

          if (debug.isEnabled) {
            yield* Effect.logDebug(chalk`API: {bold ${response.statusCode}} ${payload.method ?? 'GET'} ${payload.url}`);
          }

          return response;
        }).pipe(Effect.mapError((e) => new TwitchApiError({ message: e.message, cause: e })));

      const unique = Effect.gen(function* () {
        const response = yield* request<string>({
          url: Twitch.WebUrl,
          headers: { accept: 'text/html' },
        }).pipe(Effect.catchAll((e) => Effect.dieMessage(chalk`{red Could not fetch your unique (client-version/cookies): ${e.message}}`)));

        yield* Ref.update(headersRef, (h) => {
          const next = { ...h };
          const setCookie = response.headers['set-cookie'];
          if (Array.isArray(setCookie)) {
            Object.assign(next, parseUniqueCookies(setCookie));
          }

          const match = /twilightBuildID="([-a-z0-9]+)"/.exec(response.body);
          if (match && match[1]) {
            next['client-version'] = match[1];
          }
          return next;
        });
      });

      const validate = Effect.gen(function* () {
        const response = yield* request<{ user_id: string }>({
          url: 'https://id.twitch.tv/oauth2/validate',
          responseType: 'json',
        }).pipe(
          Effect.catchAll((e) =>
            Effect.logError(chalk`{red Could not validate your auth token: ${e.message}}`).pipe(Effect.flatMap(() => Effect.die(e))),
          ),
        );

        yield* Deferred.succeed(userIdDeferred, response.body.user_id);
      });

      const init = Effect.all([unique, validate], { concurrency: 'unbounded' });

      const executeGql = (
        requestsArray: ReadonlyArray<GraphqlRequest>,
        schemas: ReadonlyArray<AnySchema>,
      ): Effect.Effect<ReadonlyArray<unknown>, TwitchApiError> =>
        Effect.gen(function* () {
          const userId = yield* getUserId;

          const payload = requestsArray.map((r) => {
            const isDetails = r.operationName === 'DropCampaignDetails';
            const hasNoLogin = !r.variables.channelLogin;
            const variables = isDetails && hasNoLogin ? { ...r.variables, channelLogin: userId } : r.variables;

            return {
              operationName: r.operationName,
              variables,
              query: r.query,
              extensions: r.hash ? { persistedQuery: { version: 1, sha256Hash: r.hash } } : undefined,
            };
          });

          const response = yield* request<ReadonlyArray<GqlResponse<unknown>>>({
            method: 'POST',
            url: Twitch.ApiUrl,
            body: JSON.stringify(payload),
            responseType: 'json',
          });

          return yield* Effect.forEach(
            response.body,
            (res, index) => {
              const op = requestsArray[index];
              const opName = op?.operationName;

              if (res.errors && res.errors.length > 0) {
                return Effect.fail(toGraphqlError(res.errors, opName)).pipe(
                  Effect.tapError(() =>
                    debug.write({ operation: opName, variables: op?.variables, response: res }, `gql-error-${opName}-${Date.now()}`, true),
                  ),
                );
              }

              return Schema.decodeUnknown(schemas[index])(res.data).pipe(
                Effect.tapError((e) =>
                  debug.write(
                    { operation: opName, variables: op?.variables, response: res, error: e },
                    `gql-validation-error-${opName}-${Date.now()}`,
                    true,
                  ),
                ),
                Effect.mapError(
                  (e) =>
                    new TwitchApiError({
                      message: opName ? `[${opName}] GraphQL Validation Error` : 'GraphQL Validation Error',
                      cause: e,
                    }),
                ),
              );
            },
            { concurrency: 'unbounded' },
          );
        }).pipe(
          Effect.retry({
            while: (e) => e.retryable === true,
            schedule: Schedule.exponential('1 seconds').pipe(Schedule.compose(Schedule.recurs(5))),
          }),
        );

      const graphql = <A, I>(
        requests: ReadonlyArray<GraphqlRequest>,
        schema: Schema.Schema<A, I, never>,
      ): Effect.Effect<ReadonlyArray<A>, TwitchApiError> =>
        executeGql(
          requests,
          requests.map(() => schema as AnySchema),
        ) as Effect.Effect<ReadonlyArray<A>, TwitchApiError>;

      const graphqlBatch = <const S extends ReadonlyArray<AnySchema>>(
        requests: ReadonlyArray<GraphqlRequest>,
        schemas: S,
      ): Effect.Effect<SchemaTypes<S>, TwitchApiError> => executeGql(requests, schemas) as Effect.Effect<SchemaTypes<S>, TwitchApiError>;

      const gqlOne = <S extends AnySchema>(gqlRequest: GraphqlRequest, schema: S): Effect.Effect<SchemaType<S>, TwitchApiError> =>
        executeGql([gqlRequest], [schema]).pipe(Effect.map((res) => res[0] as SchemaType<S>));

      const findLastHttpUrl = (text: string): string | undefined => {
        const lastIndex = text.lastIndexOf('\nhttp');

        if (lastIndex === -1) {
          if (!text.startsWith('http')) {
            return undefined;
          }

          const [firstLine] = text.split('\n', 1);
          return firstLine.trim();
        }

        const start = lastIndex + 1;
        const end = text.indexOf('\n', start);

        if (end === -1) {
          return text.substring(start).trim();
        }

        return text.substring(start, end).trim();
      };

      // The master playlist lists variant playlists; the last entry is the
      // cheapest (audio only) rendition, which is all a watch heartbeat needs.
      const getHlsUrl = (login: string): Effect.Effect<string, TwitchApiError> =>
        Effect.gen(function* () {
          const playback = yield* playbackToken(login);
          const token = playback.streamPlaybackAccessToken;

          const master = yield* request<string>({
            url: `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`,
            searchParams: { sig: token.signature, token: token.value },
            headers: { accept: 'application/x-mpegURL' },
          });

          const url = findLastHttpUrl(typeof master.body === 'string' ? master.body : '');
          if (!url) {
            return yield* new TwitchApiError({ message: 'HLS URL not found' });
          }

          return url;
        });

      // Fetching the variant playlist proves liveness on its own: Twitch serves
      // 404 once a stream is gone and marks a finished one with EXT-X-ENDLIST,
      // so no follow-up segment probe is needed.
      const isStreamLive = (playlistUrl: string): Effect.Effect<boolean, TwitchApiError> =>
        request<string>({ url: playlistUrl, headers: { accept: 'application/x-mpegURL' } }).pipe(
          Effect.map((res) => {
            const body = typeof res.body === 'string' ? res.body : '';
            return res.statusCode === 200 && body.length > 0 && !body.includes('#EXT-X-ENDLIST');
          }),
          Effect.orElseSucceed(() => false),
        );

      const sendMinuteWatched = (channel: Channel): Effect.Effect<boolean, TwitchApiError> =>
        Effect.gen(function* () {
          const userId = yield* getUserId;

          const payload = JSON.stringify([
            {
              event: 'minute-watched',
              properties: {
                hidden: false,
                live: true,
                location: 'channel',
                logged_in: true,
                muted: false,
                player: 'site',
                channel: channel.login,
                channel_id: channel.id,
                broadcast_id: channel.currentSid,
                user_id: userId,
                game: channel.currentGameName,
                game_id: channel.currentGameId,
              },
            },
          ]);

          const response = yield* request({
            method: 'POST',
            url: 'https://spade.twitch.tv/track',
            body: Buffer.from(payload).toString('base64'),
          });

          return response.statusCode === 204;
        }).pipe(Effect.orElseSucceed(() => false));

      const watch = (channel: Channel): Effect.Effect<{ readonly success: boolean; readonly hlsUrl?: string }, TwitchApiError> => {
        if (!channel.currentSid) {
          return Effect.succeed({ success: false });
        }

        return Effect.gen(function* () {
          let hlsUrl = channel.hlsUrl ?? (yield* getHlsUrl(channel.login));

          if (yield* isStreamLive(hlsUrl)) {
            return { success: yield* sendMinuteWatched(channel), hlsUrl };
          }

          // A cached playlist can go stale while the stream is still up, so
          // resolve a fresh one once before concluding the channel is offline.
          if (channel.hlsUrl) {
            hlsUrl = yield* getHlsUrl(channel.login);

            if (yield* isStreamLive(hlsUrl)) {
              return { success: yield* sendMinuteWatched(channel), hlsUrl };
            }
          }

          return { success: false, hlsUrl };
        }).pipe(Effect.orElseSucceed(() => ({ success: false, hlsUrl: channel.hlsUrl })));
      };

      const dropsDashboard = gqlOne(GqlQueries.dropsDashboard, ViewerDropsDashboardSchema);

      const inventory = gqlOne(GqlQueries.inventory, InventorySchema);

      const claimPoints = (channelID: string, claimID: string) => gqlOne(GqlQueries.claimPoints(channelID, claimID), ClaimPointsSchema);

      const claimMoments = (momentID: string) => gqlOne(GqlQueries.claimMoments(momentID), ClaimMomentsSchema);

      const claimDrops = (dropInstanceID: string) => gqlOne(GqlQueries.claimDrops(dropInstanceID), ClaimDropsSchema);

      const playbackToken = (login: string) => gqlOne(GqlQueries.playbackToken(login), PlaybackTokenSchema);

      const helixStreams = (userIds: readonly string[]): Effect.Effect<SchemaType<typeof HelixStreamsSchema>, TwitchApiError> =>
        Effect.gen(function* () {
          if (userIds.length === 0) {
            return { data: [] };
          }

          const res = yield* request<Schema.Schema.Encoded<typeof HelixStreamsSchema>>({
            url: 'https://api.twitch.tv/helix/streams',
            headers: { 'client-id': 'uaw3vx1k0ttq74u9b2zfvt768eebh1' },
            searchParams: new URLSearchParams(userIds.map((id) => ['user_id', id] as [string, string])),
            responseType: 'json',
          });

          return yield* Schema.decodeUnknown(HelixStreamsSchema)(res.body).pipe(
            Effect.mapError((e) => new TwitchApiError({ message: `Helix validation failed: ${e}`, cause: e })),
          );
        });

      return {
        init: Effect.asVoid(init),
        userId: getUserId,
        graphql,
        graphqlBatch,
        watch,
        dropsDashboard,
        inventory,
        helixStreams,
        claimPoints,
        claimMoments,
        claimDrops,
      } satisfies TwitchApi;
    }),
  );
