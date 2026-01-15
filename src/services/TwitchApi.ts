import { Context, Data, Effect, Layer, Ref, Schedule, Schema } from 'effect';

import { HttpClientTag } from '../structures/HttpClient';

export class TwitchApiError extends Data.TaggedError('TwitchApiError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const GraphqlRequestSchema = Schema.Struct({
  operationName: Schema.String,
  variables: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  query: Schema.optional(Schema.String),
  hash: Schema.optional(Schema.String),
});

export type GraphqlRequest = Schema.Schema.Type<typeof GraphqlRequestSchema>;

export const GqlQueries = {
  dropsDashboard: {
    operationName: 'ViewerDropsDashboard',
    hash: '5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619',
    variables: { fetchRewardCampaigns: true },
  },
  campaignDetails: (dropID: string, channelLogin?: string) => ({
    operationName: 'DropCampaignDetails',
    hash: '039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1',
    variables: { dropID, channelLogin },
  }),
  gameDirectory: (slug: string) => ({
    operationName: 'DirectoryPage_Game',
    hash: '98a996c3c3ebb1ba4fd65d6671c6028d7ee8d615cb540b0731b3db2a911d3649',
    variables: {
      imageWidth: 50,
      slug,
      options: {
        includeRestricted: ['SUB_ONLY_LIVE'],
        sort: 'VIEWER_COUNT',
        recommendationsContext: { platform: 'web' },
        requestID: 'JIRA-VXP-2397',
        freeformTags: null,
        tags: [],
        broadcasterLanguages: [],
        systemFilters: ['DROPS_ENABLED'],
      },
      sortTypeIsRecency: false,
      limit: 30,
      includeCostreaming: false,
    },
  }),
  inventory: {
    operationName: 'Inventory',
    hash: 'd86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b',
    variables: { fetchRewardCampaigns: true },
  },
  currentDrops: {
    operationName: 'DropCurrentSessionContext',
    hash: '4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b',
    variables: {},
  },
  channelLive: (channelLogin: string) => ({
    operationName: 'UseLive',
    hash: '639d5f11bfb8bf3053b424d9ef650d04c4ebb7d94711d644afb08fe9a0fad5d9',
    variables: { channelLogin },
  }),
  channelStreams: (logins: string[]) => ({
    operationName: 'FFZ_StreamFetch',
    hash: 'e3dbb5d8509ff2ef9d6518bf6749d2112bf6fc3ee2886248579bd7db0feb6504',
    variables: { logins },
  }),
  channelDrops: (channelID: string) => ({
    operationName: 'DropsHighlightService_AvailableDrops',
    hash: '782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20',
    variables: { channelID },
  }),
  channelPoints: (channelLogin: string) => ({
    operationName: 'ChannelPointsContext',
    hash: '374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345',
    variables: { channelLogin },
  }),
  claimDrops: (dropInstanceID: string) => ({
    operationName: 'DropsPage_ClaimDropRewards',
    hash: 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930',
    variables: { input: { dropInstanceID } },
  }),
  claimPoints: (channelID: string, claimID: string) => ({
    operationName: 'ClaimCommunityPoints',
    hash: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0',
    variables: { input: { channelID, claimID } },
  }),
  claimMoments: (momentID: string) => ({
    operationName: 'CommunityMomentCallout_Claim',
    hash: 'e2d67415aead910f7f9ceb45a77b750a1e1d9622c936d832328a0689e054db62',
    variables: { input: { momentID } },
  }),
  playbackToken: (login: string) => ({
    operationName: 'PlaybackAccessToken',
    hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
    variables: {
      isLive: true,
      login,
      isVod: false,
      vodID: '',
      playerType: 'site',
      platform: 'web',
    },
  }),
} as const;

export interface GraphqlResponse<T = unknown> {
  readonly data: T;
  readonly errors?: ReadonlyArray<{
    readonly message: string;
    readonly path: ReadonlyArray<string>;
  }>;
  readonly extensions?: {
    readonly durationMilliseconds: number;
    readonly operationName: string;
    readonly requestID: string;
  };
}

export interface TwitchApi {
  readonly userId: Effect.Effect<string, TwitchApiError>;
  readonly graphql: <T>(requests: GraphqlRequest | ReadonlyArray<GraphqlRequest>) => Effect.Effect<ReadonlyArray<GraphqlResponse<T>>, TwitchApiError>;
  readonly request: <T = string>(
    options: any,
  ) => Effect.Effect<{ body: T; statusCode: number; headers: Record<string, string | string[] | undefined> }, TwitchApiError>;
  readonly init: Effect.Effect<void, TwitchApiError>;
  readonly channelPoints: (channelLogin: string) => Effect.Effect<any, TwitchApiError>;
  readonly channelLive: (channelLogin: string) => Effect.Effect<any, TwitchApiError>;
}

export class TwitchApiTag extends Context.Tag('@services/TwitchApi')<TwitchApiTag, TwitchApi>() {}

export const TwitchApiLayer = (authToken: string) =>
  Layer.effect(
    TwitchApiTag,
    Effect.gen(function* () {
      const http = yield* HttpClientTag;
      const userIdRef = yield* Ref.make<string | undefined>(undefined);
      const headersRef = yield* Ref.make<Record<string, string>>({
        authorization: `OAuth ${authToken}`,
        'client-id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',
      });

      const request = <T>(options: any) =>
        Effect.gen(function* () {
          const commonHeaders = yield* Ref.get(headersRef);
          return yield* http.request<T>({
            ...options,
            headers: { ...commonHeaders, ...options.headers },
          });
        }).pipe(Effect.mapError((e: any) => new TwitchApiError({ message: e.message, cause: e })));

      const unique = Effect.gen(function* () {
        const response = yield* request<string>({
          url: 'https://www.twitch.tv',
          headers: { accept: 'text/html' },
        });

        const setCookie = response.headers['set-cookie'];
        if (setCookie && Array.isArray(setCookie)) {
          const updates: Record<string, string> = {};
          for (const cookie of setCookie) {
            const clean = cookie.match(/(?<=\=)\w+(?=\;)/g);
            if (cookie.startsWith('server_session_id')) {
              updates['client-session-id'] = clean![0];
            } else if (cookie.startsWith('unique_id') && !cookie.startsWith('unique_id_durable')) {
              updates['x-device-id'] = clean![0];
            }
          }
          yield* Ref.update(headersRef, (h) => ({ ...h, ...updates }));
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
        });
        yield* Ref.set(userIdRef, response.body.user_id);
        return response.body.user_id;
      });

      const init = Effect.all([unique, validate], { discard: true });

      const getUserId = Ref.get(userIdRef).pipe(Effect.flatMap((id) => (id ? Effect.succeed(id) : validate)));

      const graphql = <T>(
        requests: GraphqlRequest | ReadonlyArray<GraphqlRequest>,
      ): Effect.Effect<ReadonlyArray<GraphqlResponse<T>>, TwitchApiError> =>
        Effect.gen(function* () {
          yield* getUserId;
          const args = Array.isArray(requests) ? requests : [requests];

          const body = args.map((r) => ({
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

          const response = yield* request<ReadonlyArray<GraphqlResponse<T>>>({
            method: 'POST',
            url: 'https://gql.twitch.tv/gql',
            body: JSON.stringify(body),
            responseType: 'json',
          });

          const results = response.body;
          for (const res of results) {
            if (res.errors && res.errors.length > 0) {
              const retryableErrors = ['service unavailable', 'service timeout', 'context deadline exceeded'];
              const hasUnretryable = res.errors.some((e) => !retryableErrors.includes(e.message.toLowerCase()));
              if (hasUnretryable) {
                return yield* Effect.fail(
                  new TwitchApiError({
                    message: `GraphQL Error: ${res.errors[0].message}`,
                    cause: res.errors,
                  }),
                );
              }
              return yield* Effect.fail(
                new TwitchApiError({
                  message: 'Retryable GraphQL Error',
                  cause: res.errors,
                }),
              );
            }
          }

          return results;
        }).pipe(
          Effect.retry({
            while: (e) => e instanceof TwitchApiError && e.message === 'Retryable GraphQL Error',
            schedule: Schedule.exponential('1 seconds').pipe(Schedule.compose(Schedule.recurs(5))),
          }),
        );

      const channelPoints = (channelLogin: string) => graphql<any>(GqlQueries.channelPoints(channelLogin)).pipe(Effect.map((res) => res[0]));

      return {
        userId: getUserId,
        graphql,
        request,
        init,
        channelPoints,
        channelLive: (channelLogin: string) => graphql<any>(GqlQueries.channelLive(channelLogin)).pipe(Effect.map((res) => res[0])),
      };
    }),
  );
