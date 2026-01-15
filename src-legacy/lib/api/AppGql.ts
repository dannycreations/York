import { AppApi } from './AppApi';

import type { GraphqlRequest, GraphqlResponse } from './AppApi';
import type { CampaignDetails } from './types/CampaignDetails';
import type { ChannelDrops } from './types/ChannelDrops';
import type { ChannelPoints } from './types/ChannelPoints';
import type { ChannelStreams } from './types/ChannelStreams';
import type { ClaimDrops } from './types/ClaimDrops';
import type { ClaimPoints } from './types/ClaimPoints';
import type { CurrentDrops } from './types/CurrentDrops';
import type { DropsDashboard } from './types/DropsDashboard';
import type { GameDirectory } from './types/GameDirectory';
import type { Inventory } from './types/Inventory';
import type { PlaybackToken } from './types/PlaybackToken';
import type { UseLive } from './types/UseLive';

export const GqlQuery = {
  dropsDashboard: (): GraphqlRequest => ({
    operationName: 'ViewerDropsDashboard',
    hash: '5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619',
    variables: { fetchRewardCampaigns: true },
  }),
  campaignDetails: (variables: CampaignDetail): GraphqlRequest => ({
    operationName: 'DropCampaignDetails',
    hash: '039277bf98f3130929262cc7c6efd9c141ca3749cb6dca442fc8ead9a53f77c1',
    variables,
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
  inventory: (): GraphqlRequest => ({
    operationName: 'Inventory',
    hash: 'd86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b',
    variables: { fetchRewardCampaigns: true },
  }),
  currentDrops: (): GraphqlRequest => ({
    operationName: 'DropCurrentSessionContext',
    hash: '4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b',
    variables: {},
  }),
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
  claimPoints: (input: ClaimPoint): GraphqlRequest => ({
    operationName: 'ClaimCommunityPoints',
    hash: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0',
    variables: { input },
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

export class AppGql extends AppApi {
  public async dropsDashboard(): Promise<GraphqlResponse<DropsDashboard>> {
    return this.graphqlOne(GqlQuery.dropsDashboard());
  }

  public async campaignDetails(campaign: CampaignDetail): Promise<GraphqlResponse<CampaignDetails>> {
    campaign = { channelLogin: this.userId, ...campaign };
    return this.graphqlOne(GqlQuery.campaignDetails(campaign));
  }

  public async gameDirectory(slug: string): Promise<GraphqlResponse<GameDirectory>> {
    return this.graphqlOne(GqlQuery.gameDirectory(slug));
  }

  public async inventory(): Promise<GraphqlResponse<Inventory>> {
    return this.graphqlOne(GqlQuery.inventory());
  }

  public async currentDrops(): Promise<GraphqlResponse<CurrentDrops>> {
    return this.graphqlOne(GqlQuery.currentDrops());
  }

  public async channelLive(channelLogin: string): Promise<GraphqlResponse<UseLive>> {
    return this.graphqlOne(GqlQuery.channelLive(channelLogin));
  }

  public async channelStreams(logins: string[]): Promise<GraphqlResponse<ChannelStreams>> {
    return this.graphqlOne(GqlQuery.channelStreams(logins));
  }

  public async channelDrops(channelID: string): Promise<GraphqlResponse<ChannelDrops>> {
    return this.graphqlOne(GqlQuery.channelDrops(channelID));
  }

  public async channelPoints(channelLogin: string): Promise<GraphqlResponse<ChannelPoints>> {
    return this.graphqlOne(GqlQuery.channelPoints(channelLogin));
  }

  public async claimDrops(dropInstanceID: string): Promise<GraphqlResponse<ClaimDrops>> {
    return this.graphqlOne(GqlQuery.claimDrops(dropInstanceID));
  }

  public async claimPoints(input: ClaimPoint): Promise<GraphqlResponse<ClaimPoints>> {
    return this.graphqlOne(GqlQuery.claimPoints(input));
  }

  public async claimMoments(momentID: string): Promise<GraphqlResponse<{}>> {
    return this.graphqlOne(GqlQuery.claimMoments(momentID));
  }

  public async playbackToken(login: string): Promise<GraphqlResponse<PlaybackToken>> {
    return this.graphqlOne(GqlQuery.playbackToken(login));
  }

  private async graphqlOne<T>(request: GraphqlRequest): Promise<GraphqlResponse<T>> {
    return (await super.graphql<T>(request))[0];
  }
}

export interface CampaignDetail {
  dropID: string;
  channelLogin?: string;
}

export interface ClaimPoint {
  claimID: string;
  channelID: string;
}
