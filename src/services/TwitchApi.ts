import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chalk } from '@vegapunk/utilities';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Context, Data, Deferred, Effect, Layer, Option, Ref, Schedule, Schema } from 'effect';
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
  ContributeCommunityGoalSchema,
  CurrentDropsSchema,
  GameDirectorySchema,
  HelixStreamsSchema,
  InventorySchema,
  PlaybackTokenSchema,
  UserPointsContributionSchema,
  ViewerDropsDashboardSchema,
} from '../core/Schemas';
import { HttpClientError, HttpClientTag } from '../structures/HttpClient';
import { GqlQueries } from './TwitchGql';

import type { ReadonlyRecord } from 'effect/Record';
import type { Channel, GqlResponse } from '../core/Schemas';
import type { DefaultOptions } from '../structures/HttpClient';
import type { GraphqlRequest } from './TwitchGql';

export class TwitchApiError extends Data.TaggedError('TwitchApiError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TwitchApi {
  readonly init: Effect.Effect<void, TwitchApiError>;
  readonly userId: Effect.Effect<string, TwitchApiError>;
  readonly writeDebugFile: (data: string | object, name?: string, force?: boolean) => Effect.Effect<void>;
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
  readonly claimAllDropsFromInventory: Effect.Effect<void, TwitchApiError>;
  readonly userPointsContribution: (channelLogin: string) => Effect.Effect<Schema.Schema.Type<typeof UserPointsContributionSchema>, TwitchApiError>;
  readonly contributeCommunityGoal: (
    channelID: string,
    goalID: string,
    amount: number,
  ) => Effect.Effect<Schema.Schema.Type<typeof ContributeCommunityGoalSchema>, TwitchApiError>;
  readonly campaignDetails: (
    dropID: string,
    channelLogin?: string,
  ) => Effect.Effect<Schema.Schema.Type<typeof CampaignDetailsSchema>, TwitchApiError>;
  readonly playbackToken: (login: string) => Effect.Effect<Schema.Schema.Type<typeof PlaybackTokenSchema>, TwitchApiError>;
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

const handleGraphqlErrors = (errors: ReadonlyArray<{ readonly message: string }>, operationName?: string): Effect.Effect<never, TwitchApiError> => {
  const opPrefix = operationName ? `[${operationName}] ` : '';
  const firstErrorMessage = errors[0]?.message ?? 'Unknown error';
  const hasRetryable = errors.some((e) => RETRYABLE_GQL_ERRORS.has(e.message.toLowerCase()));

  if (hasRetryable) {
    return Effect.logWarning(chalk`{yellow ${opPrefix}GraphQL response has retryable errors}`).pipe(
      Effect.zipRight(Effect.fail(new TwitchApiError({ message: `${opPrefix}Retryable GraphQL Error`, cause: errors }))),
    );
  }

  return Effect.fail(
    new TwitchApiError({
      message: `${opPrefix}GraphQL Error: ${firstErrorMessage}`,
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
      const userAgent = new UserAgent({ deviceCategory: 'mobile' }).toString();
      const headersRef = yield* Ref.make<Record<string, string>>({
        'user-agent': userAgent,
        authorization: `OAuth ${authToken}`,
        'client-id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',
      });

      const getUserId = Deferred.await(userIdDeferred);

      const writeDebugFile = (data: string | object, name?: string, force: boolean = false): Effect.Effect<void> => {
        if (!isDebug && !force) {
          return Effect.void;
        }

        const content = isObjectLike(data) ? JSON.stringify(data, null, 2) : data;
        const debugDir = join(process.cwd(), 'debug');

        return Effect.tryPromise({
          try: async () => {
            const fileName = `${name ?? Date.now()}.json`;
            await mkdir(debugDir, { recursive: true });
            await writeFile(join(debugDir, fileName), content);
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

          if (!isDebug && !isDebugOverride) {
            return response;
          }

          yield* Effect.logDebug(chalk`API: {bold ${response.statusCode}} ${payload.method ?? 'GET'} ${payload.url}`);

          if (!isDebugOverride) {
            return response;
          }

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

          return response;
        }).pipe(
          Effect.mapError((e) => (e instanceof HttpClientError ? new TwitchApiError(e) : new TwitchApiError({ message: String(e), cause: e }))),
        );

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

        if (response.statusCode === 401) {
          return yield* Effect.die(new TwitchApiError({ message: 'Unauthorized: Invalid OAuth token detected during validation' }));
        }

        yield* Deferred.succeed(userIdDeferred, response.body.user_id);
        return response.body.user_id;
      });

      const init = Effect.all([unique, validate], { concurrency: 'unbounded' });

      const graphql = <A, I, R>(
        requests: GraphqlRequest | ReadonlyArray<GraphqlRequest>,
        schema: Schema.Schema<A, I, R>,
        waitForUserId = true,
      ): Effect.Effect<ReadonlyArray<A>, TwitchApiError, R> => {
        const requestsArray = Array.isArray(requests) ? requests : [requests];
        const decode = Schema.decodeUnknown(schema);

        return Effect.gen(function* () {
          const userId = waitForUserId ? yield* getUserId : '';

          const payload = requestsArray.map((r) => {
            const isDetails = r.operationName === 'DropCampaignDetails';
            const hasNoLogin = !r.variables.channelLogin;

            const variables = isDetails && hasNoLogin && userId ? { ...r.variables, channelLogin: userId } : r.variables;

            if (!r.hash) {
              return {
                operationName: r.operationName,
                variables,
                query: r.query,
                extensions: undefined,
              };
            }

            return {
              operationName: r.operationName,
              variables,
              query: r.query,
              extensions: {
                persistedQuery: {
                  version: 1,
                  sha256Hash: r.hash,
                },
              },
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
                return handleGraphqlErrors(res.errors, opName).pipe(
                  Effect.tapError(() =>
                    writeDebugFile(
                      {
                        operation: opName,
                        variables: op?.variables,
                        response: res,
                      },
                      `gql-error-${opName}-${Date.now()}`,
                      true,
                    ),
                  ),
                );
              }

              return decode(res.data).pipe(
                Effect.tapError((e) =>
                  writeDebugFile(
                    {
                      operation: opName,
                      variables: op?.variables,
                      response: res,
                      error: e,
                    },
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
            while: (e) => e.message.includes('Retryable GraphQL Error'),
            schedule: Schedule.exponential('1 seconds').pipe(Schedule.compose(Schedule.recurs(5))),
          }),
        );
      };

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

      const getHlsUrl = (login: string): Effect.Effect<string, TwitchApiError> =>
        Effect.gen(function* () {
          const playback = yield* playbackToken(login);
          const token = playback.streamPlaybackAccessToken;

          const hls = yield* request({
            url: `https://usher.ttvnw.net/api/channel/hls/${login}.m3u8`,
            searchParams: { sig: token.signature, token: token.value },
            headers: { accept: 'application/x-mpegURL' },
          });

          const url = findLastHttpUrl(hls.body as string);
          if (!url) {
            return yield* new TwitchApiError({ message: 'HLS URL not found' });
          }

          return url;
        }).pipe(
          Effect.catchAll((e) =>
            e instanceof TwitchApiError ? Effect.fail(e) : Effect.fail(new TwitchApiError({ message: 'Failed to get HLS URL', cause: e })),
          ),
        );

      const checkStream = (hlsUrl: string): Effect.Effect<boolean, TwitchApiError> =>
        Effect.gen(function* () {
          const hls = yield* request({ url: hlsUrl, headers: { accept: 'application/x-mpegURL' } });
          const chunkUrl = findLastHttpUrl(hls.body as string);
          if (!chunkUrl) {
            return false;
          }

          const res = yield* request({ method: 'HEAD', url: chunkUrl });
          return res.statusCode === 200;
        }).pipe(Effect.catchAll(() => Effect.succeed(false)));

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
        }).pipe(Effect.catchAll(() => Effect.succeed(false)));

      const watch = (channel: Channel): Effect.Effect<{ readonly success: boolean; readonly hlsUrl?: string }, TwitchApiError> =>
        Effect.gen(function* () {
          const hasNoSid = !channel.currentSid;

          if (hasNoSid) {
            return { success: false };
          }

          const streamResult = yield* Effect.gen(function* () {
            const hlsUrl = channel.hlsUrl || (yield* getHlsUrl(channel.login));
            const isSuccess = yield* checkStream(hlsUrl);

            if (isSuccess) {
              const success = yield* sendMinuteWatched(channel);
              return { success, hlsUrl };
            }

            const live = yield* channelLive(channel.login);
            if (!live.user?.stream?.id) {
              return { success: false, hlsUrl };
            }

            const freshHlsUrl = yield* getHlsUrl(channel.login);
            const isFreshSuccess = yield* checkStream(freshHlsUrl);

            if (!isFreshSuccess) {
              return { success: false, hlsUrl: freshHlsUrl };
            }

            const success = yield* sendMinuteWatched(channel);
            return { success, hlsUrl: freshHlsUrl };
          }).pipe(Effect.catchAll(() => Effect.succeed({ success: false, hlsUrl: channel.hlsUrl })));

          return streamResult;
        });

      const mapFirst = <A, E, R>(effect: Effect.Effect<ReadonlyArray<A>, E, R>) => effect.pipe(Effect.map((res) => res[0]));

      const dropsDashboard = mapFirst(graphql(GqlQueries.dropsDashboard, ViewerDropsDashboardSchema));

      const inventory = mapFirst(graphql(GqlQueries.inventory, InventorySchema));

      const currentDrops = mapFirst(graphql(GqlQueries.currentDrops, CurrentDropsSchema));

      const gameDirectory = (slug: string): Effect.Effect<Schema.Schema.Type<typeof GameDirectorySchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.gameDirectory(slug), GameDirectorySchema));

      const channelPoints = (channelLogin: string): Effect.Effect<Schema.Schema.Type<typeof ChannelPointsSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.channelPoints(channelLogin), ChannelPointsSchema));

      const channelLive = (channelLogin: string): Effect.Effect<Schema.Schema.Type<typeof ChannelLiveSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.channelLive(channelLogin), ChannelLiveSchema));

      const helixStreams = (userId: string): Effect.Effect<Schema.Schema.Type<typeof HelixStreamsSchema>, TwitchApiError> =>
        Effect.gen(function* () {
          const res = yield* request<Schema.Schema.Encoded<typeof HelixStreamsSchema>>({
            url: 'https://api.twitch.tv/helix/streams',
            headers: { 'client-id': 'uaw3vx1k0ttq74u9b2zfvt768eebh1' },
            searchParams: { user_id: userId },
            responseType: 'json',
          });

          const decoded = yield* Schema.decodeUnknown(HelixStreamsSchema)(res.body).pipe(
            Effect.mapError((e) => new TwitchApiError({ message: `Helix validation failed: ${e}`, cause: e })),
          );

          return decoded;
        });

      const channelStreams = (logins: readonly string[]): Effect.Effect<Schema.Schema.Type<typeof ChannelStreamsSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.channelStreams(logins), ChannelStreamsSchema));

      const channelDrops = (channelID: string): Effect.Effect<Schema.Schema.Type<typeof ChannelDropsSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.channelDrops(channelID), ChannelDropsSchema));

      const claimPoints = (channelID: string, claimID: string): Effect.Effect<Schema.Schema.Type<typeof ClaimPointsSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.claimPoints(channelID, claimID), ClaimPointsSchema));

      const claimMoments = (momentID: string): Effect.Effect<Schema.Schema.Type<typeof ClaimMomentsSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.claimMoments(momentID), ClaimMomentsSchema));

      const claimDrops = (dropInstanceID: string): Effect.Effect<Schema.Schema.Type<typeof ClaimDropsSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.claimDrops(dropInstanceID), ClaimDropsSchema));

      const claimAllDropsFromInventory: Effect.Effect<void, TwitchApiError> = inventory.pipe(
        Effect.flatMap((inv) =>
          Effect.gen(function* () {
            const campaigns = inv.currentUser.inventory.dropCampaignsInProgress;

            for (const campaign of campaigns) {
              for (const drop of campaign.timeBasedDrops) {
                const dropInstanceID = drop.self?.dropInstanceID;
                const isClaimable = !!drop.self && !drop.self.isClaimed && !!dropInstanceID;

                if (!isClaimable) {
                  continue;
                }

                const claimRes = yield* claimDrops(dropInstanceID!).pipe(Effect.option, Effect.orDie);
                if (Option.isSome(claimRes) && claimRes.value.claimDropRewards) {
                  yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Drops claimed}`);
                }
              }
            }
          }),
        ),
      );

      const userPointsContribution = (channelLogin: string): Effect.Effect<Schema.Schema.Type<typeof UserPointsContributionSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.userPointsContribution(channelLogin), UserPointsContributionSchema));

      const contributeCommunityGoal = (
        channelID: string,
        goalID: string,
        amount: number,
      ): Effect.Effect<Schema.Schema.Type<typeof ContributeCommunityGoalSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.contributeCommunityGoal(channelID, goalID, amount), ContributeCommunityGoalSchema));

      const campaignDetails = (
        dropID: string,
        channelLogin?: string,
      ): Effect.Effect<Schema.Schema.Type<typeof CampaignDetailsSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.campaignDetails(dropID, channelLogin), CampaignDetailsSchema));

      const playbackToken = (login: string): Effect.Effect<Schema.Schema.Type<typeof PlaybackTokenSchema>, TwitchApiError> =>
        mapFirst(graphql(GqlQueries.playbackToken(login), PlaybackTokenSchema));

      return {
        init,
        userId: getUserId,
        writeDebugFile,
        graphql,
        request,
        watch,
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
        claimAllDropsFromInventory,
        userPointsContribution,
        contributeCommunityGoal,
        campaignDetails,
        playbackToken,
      };
    }),
  );
