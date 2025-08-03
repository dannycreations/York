import { GraphqlRequest, GraphqlResponse, TwitchApi } from './TwitchApi';
import { CampaignDetails } from './types/CampaignDetails';
import { ChannelDrops } from './types/ChannelDrops';
import { ChannelPoints } from './types/ChannelPoints';
import { ChannelStreams } from './types/ChannelStreams';
import { ClaimDrops } from './types/ClaimDrops';
import { ClaimPoints } from './types/ClaimPoints';
import { CurrentDrops } from './types/CurrentDrops';
import { DropsDashboard } from './types/DropsDashboard';
import { GameDirectory } from './types/GameDirectory';
import { Inventory } from './types/Inventory';
import { PlaybackToken } from './types/PlaybackToken';
import { UseLive } from './types/UseLive';

/**
 * ! TODO: Better data structure
 * ! for single and multi gql request
 */
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
      includeIsDJ: false,
    },
    hash: 'c7c9d5aad09155c4161d2382092dc44610367f3536aac39019ec2582ae5065f9',
  }),
  inventory: (): GraphqlRequest => ({
    operationName: 'Inventory',
    variables: { fetchRewardCampaigns: true },
    hash: '09acb7d3d7e605a92bdfdcc465f6aa481b71c234d8686a9ba38ea5ed51507592',
  }),
  currentDrops: (): GraphqlRequest => ({
    operationName: 'DropCurrentSessionContext',
    variables: {},
    hash: '4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b',
  }),
  channelLive: (channelLogin: string): GraphqlRequest => ({
    operationName: 'UseLive',
    variables: { channelLogin },
    hash: '639d5f11bfb8bf3053b424d9ef650d04c4ebb7d94711d644afb08fe9a0fad5d9',
  }),
  channelStreams: (logins: string[]): GraphqlRequest => ({
    operationName: 'FFZ_StreamFetch',
    variables: { logins },
    hash: 'e3dbb5d8509ff2ef9d6518bf6749d2112bf6fc3ee2886248579bd7db0feb6504',
  }),
  channelDrops: (channelID: string): GraphqlRequest => ({
    operationName: 'DropsHighlightService_AvailableDrops',
    variables: { channelID },
    hash: 'eff13f4a43157238e40b4cd74b0dac3a41b5f8fb31de1a3b19347fae84e60b92',
  }),
  channelPoints: (channelLogin: string): GraphqlRequest => ({
    operationName: 'ChannelPointsContext',
    variables: { channelLogin },
    hash: '1530a003a7d374b0380b79db0be0534f30ff46e61cffa2bc0e2468a909fbc024',
  }),
  claimDrops: (dropInstanceID: string): GraphqlRequest => ({
    operationName: 'DropsPage_ClaimDropRewards',
    variables: { input: { dropInstanceID } },
    hash: 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930',
  }),
  claimPoints: (input: ClaimPoint): GraphqlRequest => ({
    operationName: 'ClaimCommunityPoints',
    variables: { input },
    hash: '46aaeebe02c99afdf4fc97c7c0cba964124bf6b0af229395f1f6d1feed05b3d0',
  }),
  claimMoments: (momentID: string): GraphqlRequest => ({
    operationName: 'CommunityMomentCallout_Claim',
    variables: { input: { momentID } },
    hash: 'e2d67415aead910f7f9ceb45a77b750a1e1d9622c936d832328a0689e054db62',
  }),
  playbackToken: (login: string): GraphqlRequest => ({
    operationName: 'PlaybackAccessToken',
    variables: {
      isLive: true,
      login,
      isVod: false,
      vodID: '',
      playerType: 'site',
      platform: 'web',
    },
    hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
  }),
} as const;

export class TwitchGql extends TwitchApi {
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
