import { Schema } from 'effect';

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
  campaignDetails: (dropID: string, channelLogin?: string): GraphqlRequest => ({
    operationName: 'DropCampaignDetails',
    hash: '039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1',
    variables: { dropID, channelLogin },
  }),
  gameDirectory: (slug: string): GraphqlRequest => ({
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
  channelLive: (channelLogin: string): GraphqlRequest => ({
    operationName: 'UseLive',
    hash: '639d5f11bfb8bf3053b424d9ef650d04c4ebb7d94711d644afb08fe9a0fad5d9',
    variables: { channelLogin },
  }),
  channelStreams: (logins: string[]): GraphqlRequest => ({
    operationName: 'FFZ_StreamFetch',
    hash: 'e3dbb5d8509ff2ef9d6518bf6749d2112bf6fc3ee2886248579bd7db0feb6504',
    variables: { logins },
  }),
  channelDrops: (channelID: string): GraphqlRequest => ({
    operationName: 'DropsHighlightService_AvailableDrops',
    hash: '782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20',
    variables: { channelID },
  }),
  channelPoints: (channelLogin: string): GraphqlRequest => ({
    operationName: 'ChannelPointsContext',
    hash: '374314de591e69925fce3ddc2bcf085796f56ebb8cad67a0daa3165c03adc345',
    variables: { channelLogin },
  }),
  claimDrops: (dropInstanceID: string): GraphqlRequest => ({
    operationName: 'DropsPage_ClaimDropRewards',
    hash: 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930',
    variables: { input: { dropInstanceID } },
  }),
  claimPoints: (channelID: string, claimID: string): GraphqlRequest => ({
    operationName: 'ClaimCommunityPoints',
    hash: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0',
    variables: { input: { channelID, claimID } },
  }),
  claimMoments: (momentID: string): GraphqlRequest => ({
    operationName: 'CommunityMomentCallout_Claim',
    hash: 'e2d67415aead910f7f9ceb45a77b750a1e1d9622c936d832328a0689e054db62',
    variables: { input: { momentID } },
  }),
  playbackToken: (login: string): GraphqlRequest => ({
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
