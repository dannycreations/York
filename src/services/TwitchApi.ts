import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Context, Data, Deferred, Effect, Layer, Ref, Schedule, Schema } from 'effect';
import UserAgent from 'user-agents';

import { Twitch } from '../core/Constants';
import {
  CampaignDetailsSchema,
  ChannelDropsSchema,
  ChannelLiveSchema,
  ChannelPointsSchema,
  ChannelStreamsSchema,
  ClaimDropsSchema,
  ClaimMomentsSchema,
  ClaimPointsSchema,
  CurrentDropsSchema,
  GameDirectorySchema,
  HelixStreamsSchema,
  InventorySchema,
  PlaybackTokenSchema,
  ViewerDropsDashboardSchema,
} from '../core/Schemas';
import { HttpClientError, HttpClientTag } from '../structures/HttpClient';
import { GqlQueries } from './TwitchQueries';

import type { ReadonlyRecord } from 'effect/Record';
import type { GqlResponse } from '../core/Schemas';
import type { DefaultOptions } from '../structures/HttpClient';
import type { GraphqlRequest } from './TwitchQueries';

export class TwitchApiError extends Data.TaggedError('TwitchApiError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TwitchApi {
  readonly userId: Effect.Effect<string, TwitchApiError>;
  readonly writeDebugFile: (data: string | object, name?: string) => Effect.Effect<void>;
  readonly graphql: <A, I, R>(
    requests: GraphqlRequest | ReadonlyArray<GraphqlRequest>,
    schema: Schema.Schema<A, I, R>,
    waitForUserId?: boolean,
  ) => Effect.Effect<ReadonlyArray<A>, TwitchApiError, R>;
  readonly request: <T = string>(
    options: string | DefaultOptions,
    isDebugOverride?: boolean,
  ) => Effect.Effect<
    {
      body: T;
      statusCode: number;
      headers: Record<string, string | string[] | undefined>;
    },
    TwitchApiError
  >;
  readonly init: Effect.Effect<void, TwitchApiError>;
  readonly dropsDashboard: Effect.Effect<Schema.Schema.Type<typeof ViewerDropsDashboardSchema>, TwitchApiError>;
  readonly inventory: Effect.Effect<Schema.Schema.Type<typeof InventorySchema>, TwitchApiError>;
  readonly currentDrops: Effect.Effect<Schema.Schema.Type<typeof CurrentDropsSchema>, TwitchApiError>;
  readonly gameDirectory: (slug: string) => Effect.Effect<Schema.Schema.Type<typeof GameDirectorySchema>, TwitchApiError>;
  readonly channelPoints: (channelLogin: string) => Effect.Effect<Schema.Schema.Type<typeof ChannelPointsSchema>, TwitchApiError>;
  readonly channelLive: (channelLogin: string) => Effect.Effect<Schema.Schema.Type<typeof ChannelLiveSchema>, TwitchApiError>;
  readonly helixStreams: (userId: string) => Effect.Effect<Schema.Schema.Type<typeof HelixStreamsSchema>, TwitchApiError>;
  readonly channelStreams: (logins: readonly string[]) => Effect.Effect<Schema.Schema.Type<typeof ChannelStreamsSchema>, TwitchApiError>;
  readonly channelDrops: (channelID: string) => Effect.Effect<Schema.Schema.Type<typeof ChannelDropsSchema>, TwitchApiError>;
  readonly claimPoints: (channelID: string, claimID: string) => Effect.Effect<Schema.Schema.Type<typeof ClaimPointsSchema>, TwitchApiError>;
  readonly claimMoments: (momentID: string) => Effect.Effect<Schema.Schema.Type<typeof ClaimMomentsSchema>, TwitchApiError>;
  readonly claimDrops: (dropInstanceID: string) => Effect.Effect<Schema.Schema.Type<typeof ClaimDropsSchema>, TwitchApiError>;
  readonly campaignDetails: (
    dropID: string,
    channelLogin?: string,
  ) => Effect.Effect<Schema.Schema.Type<typeof CampaignDetailsSchema>, TwitchApiError>;
  readonly playbackToken: (login: string) => Effect.Effect<Schema.Schema.Type<typeof PlaybackTokenSchema>, TwitchApiError>;
}

export class TwitchApiTag extends Context.Tag('@services/TwitchApi')<TwitchApiTag, TwitchApi>() {}

const parseUniqueCookies = (setCookie: readonly string[]): Readonly<Record<string, string>> =>
  setCookie.reduce<Record<string, string>>((acc, cookie) => {
    const match = cookie.match(/(?<=\=)\w+(?=\;)/);
    if (!match || !match[0]) return acc;

    const value = match[0];
    if (cookie.startsWith('server_session_id')) {
      return { ...acc, 'client-session-id': value };
    }

    if (cookie.startsWith('unique_id') && !cookie.startsWith('unique_id_durable')) {
      return { ...acc, 'x-device-id': value };
    }

    return acc;
  }, {});

const handleGraphqlErrors = (errors: ReadonlyArray<{ readonly message: string }>): Effect.Effect<never, TwitchApiError> => {
  const retryableErrors = ['service unavailable', 'service timeout', 'context deadline exceeded'];
  const retries = errors.filter((e) => retryableErrors.includes(e.message.toLowerCase()));

  if (retries.length > 0) {
    return Effect.logWarning(chalk`{yellow GraphQL response has ${retries.length} retryable errors}`).pipe(
      Effect.zipRight(
        Effect.fail(
          new TwitchApiError({
            message: 'Retryable GraphQL Error',
            cause: errors,
          }),
        ),
      ),
    );
  }

  return Effect.fail(
    new TwitchApiError({
      message: `GraphQL Error: ${errors[0].message}`,
      cause: errors,
    }),
  );
};

export const TwitchApiLayer = (authToken: string, isDebug = false): Layer.Layer<TwitchApiTag, never, HttpClientTag> =>
  Layer.effect(
    TwitchApiTag,
    Effect.gen(function* () {
      const http = yield* HttpClientTag;
      const userIdDeferred = yield* Deferred.make<string>();
      const userAgent = new UserAgent({ deviceCategory: 'mobile' });
      const headersRef = yield* Ref.make<Record<string, string>>({
        'user-agent': userAgent.toString(),
        authorization: `OAuth ${authToken}`,
        'client-id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',
      });

      const getUserId = Deferred.await(userIdDeferred);

      const writeDebugFile = (data: string | object, name?: string): Effect.Effect<void> => {
        if (!isDebug) return Effect.void;

        const content = isObjectLike(data) ? JSON.stringify(data, null, 2) : data;
        const debugDir = join(process.cwd(), 'debug');

        return Effect.tryPromise({
          try: async () => {
            await mkdir(debugDir, { recursive: true });
            await writeFile(join(debugDir, `${name ?? Date.now()}.json`), content);
          },
          catch: (e) => new TwitchApiError({ message: 'Failed to write debug file', cause: e }),
        }).pipe(Effect.ignore);
      };

      const request = <T>(
        options: string | DefaultOptions,
        isDebugOverride?: boolean,
      ): Effect.Effect<
        { readonly body: T; readonly statusCode: number; readonly headers: ReadonlyRecord<string, string | string[] | undefined> },
        TwitchApiError
      > =>
        Effect.gen(function* () {
          const commonHeaders = yield* Ref.get(headersRef);
          const payload = typeof options === 'string' ? { url: options } : options;
          const response = yield* http.request<T>({
            ...payload,
            headers: { ...commonHeaders, ...payload.headers },
          });

          if (response.statusCode === 401) {
            yield* Effect.logFatal(chalk`{red Unauthorized: Invalid OAuth token detected during request}`);
            return yield* Effect.die(new TwitchApiError({ message: 'Unauthorized: Invalid OAuth token detected during request' }));
          }

          if (isDebug || isDebugOverride) {
            yield* Effect.logDebug(chalk`API: {bold ${response.statusCode}} ${payload.method ?? 'GET'} ${payload.url}`);
            if (isDebugOverride) {
              yield* writeDebugFile(
                {
                  request: {
                    url: `${response.statusCode} ${payload.method ?? 'GET'} ${payload.url}`,
                    headers: { ...commonHeaders, ...payload.headers },
                    body: payload.body,
                  },
                  response: { headers: response.headers, body: response.body },
                },
                `api-debug-${Date.now()}`,
              );
            }
          }

          return response;
        }).pipe(
          Effect.mapError((e) => (e instanceof HttpClientError ? new TwitchApiError(e) : new TwitchApiError({ message: String(e), cause: e }))),
          Effect.annotateLogs({ service: 'TwitchApi', operation: 'request' }),
        );

      const unique = request<string>({
        url: Twitch.WebUrl,
        headers: { accept: 'text/html' },
      }).pipe(
        Effect.catchAll((e) => Effect.dieMessage(chalk`{red Could not fetch your unique (client-version/cookies): ${e.message}}`)),
        Effect.flatMap((response) => {
          const setCookie = response.headers['set-cookie'];
          const updateCookies =
            setCookie && Array.isArray(setCookie) ? Ref.update(headersRef, (h) => ({ ...h, ...parseUniqueCookies(setCookie) })) : Effect.void;

          const match = /twilightBuildID="([-a-z0-9]+)"/.exec(response.body);
          const updateVersion = match && match[1] ? Ref.update(headersRef, (h) => ({ ...h, 'client-version': match[1]! })) : Effect.void;

          return Effect.all([updateCookies, updateVersion], { discard: true });
        }),
      );

      const validate = request<{ user_id: string }>({
        url: 'https://id.twitch.tv/oauth2/validate',
        responseType: 'json',
      }).pipe(
        Effect.catchAll((e) =>
          Effect.logError(chalk`{red Could not validate your auth token: ${e.message}}`).pipe(Effect.flatMap(() => Effect.die(e))),
        ),
        Effect.flatMap((response) =>
          response.statusCode === 401
            ? Effect.die(new TwitchApiError({ message: 'Unauthorized: Invalid OAuth token detected during validation' }))
            : Deferred.succeed(userIdDeferred, response.body.user_id).pipe(Effect.as(response.body.user_id)),
        ),
      );

      const init = Effect.all([unique, validate], { concurrency: 'unbounded' }).pipe(Effect.asVoid);

      const graphql = <A, I, R>(
        requests: GraphqlRequest | ReadonlyArray<GraphqlRequest>,
        schema: Schema.Schema<A, I, R>,
        waitForUserId = true,
      ): Effect.Effect<ReadonlyArray<A>, TwitchApiError, R> =>
        Effect.gen(function* () {
          const userId = waitForUserId ? yield* getUserId : '';
          const body = JSON.stringify(
            (Array.isArray(requests) ? requests : [requests]).map((r) => ({
              operationName: r.operationName,
              variables:
                r.operationName === 'DropCampaignDetails' && !r.variables.channelLogin && userId
                  ? { ...r.variables, channelLogin: userId }
                  : r.variables,
              query: r.query,
              extensions: r.hash
                ? {
                    persistedQuery: {
                      version: 1,
                      sha256Hash: r.hash,
                    },
                  }
                : undefined,
            })),
          );

          const response = yield* request<ReadonlyArray<GqlResponse<unknown>>>({
            method: 'POST',
            url: Twitch.ApiUrl,
            body,
            responseType: 'json',
          });

          const decode = Schema.decodeUnknown(schema);

          return yield* Effect.forEach(
            response.body,
            (res) =>
              res.errors && res.errors.length > 0
                ? handleGraphqlErrors(res.errors)
                : decode(res.data).pipe(Effect.mapError((e) => new TwitchApiError({ message: 'GraphQL Validation Error', cause: e }))),
            { concurrency: 'unbounded' },
          );
        }).pipe(
          Effect.retry({
            while: (e) => e.message === 'Retryable GraphQL Error',
            schedule: Schedule.exponential('1 seconds').pipe(Schedule.compose(Schedule.recurs(5))),
          }),
          Effect.annotateLogs({ service: 'TwitchApi', operation: 'graphql' }),
        );

      const dropsDashboard = graphql(GqlQueries.dropsDashboard, ViewerDropsDashboardSchema).pipe(Effect.map((res) => res[0]));

      const inventory = graphql(GqlQueries.inventory, InventorySchema).pipe(Effect.map((res) => res[0]));

      const currentDrops = graphql(GqlQueries.currentDrops, CurrentDropsSchema).pipe(Effect.map((res) => res[0]));

      const gameDirectory = (slug: string): Effect.Effect<Schema.Schema.Type<typeof GameDirectorySchema>, TwitchApiError> =>
        graphql(GqlQueries.gameDirectory(slug), GameDirectorySchema).pipe(Effect.map((res) => res[0]));

      const channelPoints = (channelLogin: string): Effect.Effect<Schema.Schema.Type<typeof ChannelPointsSchema>, TwitchApiError> =>
        graphql(GqlQueries.channelPoints(channelLogin), ChannelPointsSchema).pipe(Effect.map((res) => res[0]));

      const channelLive = (channelLogin: string): Effect.Effect<Schema.Schema.Type<typeof ChannelLiveSchema>, TwitchApiError> =>
        graphql(GqlQueries.channelLive(channelLogin), ChannelLiveSchema).pipe(Effect.map((res) => res[0]));

      const helixStreams = (userId: string): Effect.Effect<Schema.Schema.Type<typeof HelixStreamsSchema>, TwitchApiError> =>
        request<Schema.Schema.Encoded<typeof HelixStreamsSchema>>({
          url: 'https://api.twitch.tv/helix/streams',
          headers: { 'client-id': 'uaw3vx1k0ttq74u9b2zfvt768eebh1' },
          searchParams: { user_id: userId },
          responseType: 'json',
        }).pipe(
          Effect.flatMap((res) => Schema.decodeUnknown(HelixStreamsSchema)(res.body)),
          Effect.mapError((e) => (e instanceof TwitchApiError ? e : new TwitchApiError({ message: `Helix validation failed: ${e}`, cause: e }))),
        );

      const channelStreams = (logins: readonly string[]): Effect.Effect<Schema.Schema.Type<typeof ChannelStreamsSchema>, TwitchApiError> =>
        graphql(GqlQueries.channelStreams(logins), ChannelStreamsSchema).pipe(Effect.map((res) => res[0]));

      const channelDrops = (channelID: string): Effect.Effect<Schema.Schema.Type<typeof ChannelDropsSchema>, TwitchApiError> =>
        graphql(GqlQueries.channelDrops(channelID), ChannelDropsSchema).pipe(Effect.map((res) => res[0]));

      const claimPoints = (channelID: string, claimID: string): Effect.Effect<Schema.Schema.Type<typeof ClaimPointsSchema>, TwitchApiError> =>
        graphql(GqlQueries.claimPoints(channelID, claimID), ClaimPointsSchema).pipe(Effect.map((res) => res[0]));

      const claimMoments = (momentID: string): Effect.Effect<Schema.Schema.Type<typeof ClaimMomentsSchema>, TwitchApiError> =>
        graphql(GqlQueries.claimMoments(momentID), ClaimMomentsSchema).pipe(Effect.map((res) => res[0]));

      const claimDrops = (dropInstanceID: string): Effect.Effect<Schema.Schema.Type<typeof ClaimDropsSchema>, TwitchApiError> =>
        graphql(GqlQueries.claimDrops(dropInstanceID), ClaimDropsSchema).pipe(Effect.map((res) => res[0]));

      const campaignDetails = (
        dropID: string,
        channelLogin?: string,
      ): Effect.Effect<Schema.Schema.Type<typeof CampaignDetailsSchema>, TwitchApiError> =>
        graphql(GqlQueries.campaignDetails(dropID, channelLogin), CampaignDetailsSchema).pipe(Effect.map((res) => res[0]));

      const playbackToken = (login: string): Effect.Effect<Schema.Schema.Type<typeof PlaybackTokenSchema>, TwitchApiError> =>
        graphql(GqlQueries.playbackToken(login), PlaybackTokenSchema).pipe(Effect.map((res) => res[0]));

      return {
        userId: getUserId,
        writeDebugFile,
        graphql,
        request,
        init,
        dropsDashboard,
        inventory,
        currentDrops,
        gameDirectory,
        channelPoints,
        channelLive,
        helixStreams,
        channelStreams,
        channelDrops,
        claimPoints,
        claimMoments,
        claimDrops,
        campaignDetails,
        playbackToken,
      };
    }),
  );
