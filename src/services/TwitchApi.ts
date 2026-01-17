import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { Context, Data, Deferred, Effect, Layer, Ref, Schedule, Schema } from 'effect';
import UserAgent from 'user-agents';

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
  InventorySchema,
  PlaybackTokenSchema,
  ViewerDropsDashboardSchema,
} from '../core/Schemas';
import { HttpClientError, HttpClientTag } from '../structures/HttpClient';
import { GqlQueries } from './TwitchQueries';

import type { GqlResponse } from '../core/Schemas';
import type { DefaultOptions } from '../structures/HttpClient';
import type { GraphqlRequest } from './TwitchQueries';

export { GqlQueries };
export type { GraphqlRequest };

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
  ) => Effect.Effect<{ body: T; statusCode: number; headers: Record<string, string | string[] | undefined> }, TwitchApiError>;
  readonly init: Effect.Effect<void, TwitchApiError>;
  readonly dropsDashboard: Effect.Effect<Schema.Schema.Type<typeof ViewerDropsDashboardSchema>, TwitchApiError>;
  readonly inventory: Effect.Effect<Schema.Schema.Type<typeof InventorySchema>, TwitchApiError>;
  readonly currentDrops: Effect.Effect<Schema.Schema.Type<typeof CurrentDropsSchema>, TwitchApiError>;
  readonly gameDirectory: (slug: string) => Effect.Effect<Schema.Schema.Type<typeof GameDirectorySchema>, TwitchApiError>;
  readonly channelPoints: (channelLogin: string) => Effect.Effect<Schema.Schema.Type<typeof ChannelPointsSchema>, TwitchApiError>;
  readonly channelLive: (channelLogin: string) => Effect.Effect<Schema.Schema.Type<typeof ChannelLiveSchema>, TwitchApiError>;
  readonly channelStreams: (logins: string[]) => Effect.Effect<Schema.Schema.Type<typeof ChannelStreamsSchema>, TwitchApiError>;
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

export const TwitchApiLayer = (authToken: string, isDebug: boolean = false): Layer.Layer<TwitchApiTag, never, HttpClientTag> =>
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

      const writeDebugFile = (data: string | object, name?: string) =>
        Effect.gen(function* () {
          const content = typeof data === 'object' ? JSON.stringify(data, null, 2) : data;
          const debugDir = join(process.cwd(), 'debug');
          yield* Effect.tryPromise({
            try: async () => {
              await mkdir(debugDir, { recursive: true });
              await writeFile(join(debugDir, `${name ?? Date.now()}.json`), content);
            },
            catch: (e) => new TwitchApiError({ message: 'Failed to write debug file', cause: e }),
          });
        }).pipe(Effect.catchAll(() => Effect.void));

      const request = <T>(options: string | DefaultOptions, isDebugOverride?: boolean) =>
        Effect.gen(function* () {
          const commonHeaders = yield* Ref.get(headersRef);
          const payload = typeof options === 'string' ? { url: options } : options;
          const response = yield* http.request<T>({
            ...payload,
            headers: { ...commonHeaders, ...payload.headers },
          });

          if (response.statusCode === 401) {
            return yield* Effect.dieMessage('Unauthorized: Invalid OAuth token detected during request');
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
          Effect.mapError((e) =>
            e instanceof HttpClientError
              ? new TwitchApiError({ message: e.message, cause: e })
              : new TwitchApiError({ message: String(e), cause: e }),
          ),
        );

      const parseUniqueCookies = (setCookie: readonly string[]): Record<string, string> =>
        setCookie.reduce<Record<string, string>>((acc, cookie) => {
          const clean = cookie.match(/(?<=\=)\w+(?=\;)/g);
          if (clean && clean[0]) {
            if (cookie.startsWith('server_session_id')) {
              acc['client-session-id'] = clean[0];
            } else if (cookie.startsWith('unique_id') && !cookie.startsWith('unique_id_durable')) {
              acc['x-device-id'] = clean[0];
            }
          }
          return acc;
        }, {});

      const unique = Effect.gen(function* () {
        const response = yield* request<string>({
          url: 'https://www.twitch.tv',
          headers: { accept: 'text/html' },
        }).pipe(Effect.catchAll((e) => Effect.dieMessage(chalk`{red Could not fetch your unique (client-version/cookies): ${e.message}}`)));

        const setCookie = response.headers['set-cookie'];
        if (setCookie && Array.isArray(setCookie)) {
          yield* Ref.update(headersRef, (h) => ({ ...h, ...parseUniqueCookies(setCookie) }));
        }

        const htmlReg = /twilightBuildID="([-a-z0-9]+)"/;
        const match = htmlReg.exec(response.body);
        if (match) {
          yield* Ref.update(headersRef, (h) => ({ ...h, 'client-version': match[1] }));
        }
      });

      const validate = Effect.gen(function* () {
        const response = yield* request<{ user_id: string }>({
          url: 'https://id.twitch.tv/oauth2/validate',
          responseType: 'json',
        }).pipe(Effect.catchAll((e) => Effect.dieMessage(chalk`{red Could not validate your auth token: ${e.message}}`)));

        if (response.statusCode === 401) {
          return yield* Effect.dieMessage('Unauthorized: Invalid OAuth token detected during validation');
        }
        yield* Deferred.succeed(userIdDeferred, response.body.user_id);
        return response.body.user_id;
      });

      const init = Effect.zipRight(unique, validate);

      const graphql = <A, I, R>(
        requests: GraphqlRequest | ReadonlyArray<GraphqlRequest>,
        schema: Schema.Schema<A, I, R>,
        waitForUserId: boolean = true,
      ) => {
        const prepareGqlRequests = (userId: string): ReadonlyArray<GraphqlRequest> =>
          (Array.isArray(requests) ? requests : [requests]).map((r) =>
            r.operationName === 'DropCampaignDetails' && !r.variables.channelLogin && userId
              ? { ...r, variables: { ...r.variables, channelLogin: userId } }
              : r,
          );

        const buildGqlBody = (preparedRequests: ReadonlyArray<GraphqlRequest>): ReadonlyArray<unknown> =>
          preparedRequests.map((r) => ({
            operationName: r.operationName,
            variables: r.variables,
            query: r.query,
            extensions: r.hash
              ? {
                  persistedQuery: {
                    version: 1,
                    sha256Hash: r.hash,
                  },
                }
              : undefined,
          }));

        const processGqlResult = (res: GqlResponse) =>
          Effect.gen(function* () {
            if (res.errors && res.errors.length > 0) {
              const retryableErrors = ['service unavailable', 'service timeout', 'context deadline exceeded'];
              const retries = res.errors.filter((e) => retryableErrors.includes(e.message.toLowerCase()));

              if (retries.length > 0) {
                yield* Effect.logWarning(chalk`{yellow GraphQL response has ${retries.length} retryable errors}`, retries);
                return yield* Effect.fail(
                  new TwitchApiError({
                    message: 'Retryable GraphQL Error',
                    cause: res.errors,
                  }),
                );
              }

              return yield* Effect.fail(
                new TwitchApiError({
                  message: `GraphQL Error: ${res.errors[0].message}`,
                  cause: res.errors,
                }),
              );
            }

            const decode = Schema.decodeUnknown(schema);
            return yield* decode(res.data).pipe(Effect.mapError((e) => new TwitchApiError({ message: 'GraphQL Validation Error', cause: e })));
          });

        return Effect.gen(function* () {
          const userId = waitForUserId ? yield* getUserId : '';
          const preparedRequests = prepareGqlRequests(userId);
          const body = buildGqlBody(preparedRequests);

          const response = yield* request<ReadonlyArray<GqlResponse>>({
            method: 'POST',
            url: 'https://gql.twitch.tv/gql',
            body: JSON.stringify(body),
            responseType: 'json',
          });

          return yield* Effect.forEach(response.body, processGqlResult);
        }).pipe(
          Effect.retry({
            while: (e) => e instanceof TwitchApiError && e.message === 'Retryable GraphQL Error',
            schedule: Schedule.exponential('1 seconds', 2).pipe(Schedule.compose(Schedule.recurs(5))),
          }),
          Effect.annotateLogs({ service: 'TwitchApi', operation: 'graphql' }),
        );
      };

      const dropsDashboard = graphql(GqlQueries.dropsDashboard, ViewerDropsDashboardSchema).pipe(Effect.map((res) => res[0]));

      const inventory = graphql(GqlQueries.inventory, InventorySchema).pipe(Effect.map((res) => res[0]));

      const currentDrops = graphql(GqlQueries.currentDrops, CurrentDropsSchema).pipe(Effect.map((res) => res[0]));

      const gameDirectory = (slug: string) => graphql(GqlQueries.gameDirectory(slug), GameDirectorySchema).pipe(Effect.map((res) => res[0]));

      const channelPoints = (channelLogin: string) =>
        graphql(GqlQueries.channelPoints(channelLogin), ChannelPointsSchema).pipe(Effect.map((res) => res[0]));

      const channelLive = (channelLogin: string) =>
        graphql(GqlQueries.channelLive(channelLogin), ChannelLiveSchema).pipe(Effect.map((res) => res[0]));

      const channelStreams = (logins: string[]) => graphql(GqlQueries.channelStreams(logins), ChannelStreamsSchema).pipe(Effect.map((res) => res[0]));

      const channelDrops = (channelID: string) => graphql(GqlQueries.channelDrops(channelID), ChannelDropsSchema).pipe(Effect.map((res) => res[0]));

      const claimPoints = (channelID: string, claimID: string) =>
        graphql(GqlQueries.claimPoints(channelID, claimID), ClaimPointsSchema).pipe(Effect.map((res) => res[0]));

      const claimMoments = (momentID: string) => graphql(GqlQueries.claimMoments(momentID), ClaimMomentsSchema).pipe(Effect.map((res) => res[0]));

      const claimDrops = (dropInstanceID: string) =>
        graphql(GqlQueries.claimDrops(dropInstanceID), ClaimDropsSchema).pipe(Effect.map((res) => res[0]));

      const campaignDetails = (dropID: string, channelLogin?: string) =>
        graphql(GqlQueries.campaignDetails(dropID, channelLogin), CampaignDetailsSchema).pipe(Effect.map((res) => res[0]));

      const playbackToken = (login: string) => graphql(GqlQueries.playbackToken(login), PlaybackTokenSchema).pipe(Effect.map((res) => res[0]));

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
