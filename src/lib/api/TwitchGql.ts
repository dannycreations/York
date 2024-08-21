import { TwitchApi } from './TwitchApi'
import { ChannelPointsContext } from './types/ChannelPointsContext'
import { ClaimCommunityPointsMutation } from './types/ClaimCommunityPointsMutation'
import { ClaimDropRewardsMutation } from './types/ClaimDropRewardsMutation'
import { DirectoryPageGame } from './types/DirectoryPageGame'
import { DropCampaignDetails } from './types/DropCampaignDetails'
import { DropCurrentSessionContext } from './types/DropCurrentSessionContext'
import { FFZStreamFetch } from './types/FFZStreamFetch'
import { Inventory } from './types/Inventory'
import { ViewerDropsDashboard } from './types/ViewerDropsDashboard'

export class TwitchGql extends TwitchApi {
	public static readonly Instance = new TwitchGql(process.env.AUTH_TOKEN)

	public async dropsDashboard() {
		return super.graphql<ViewerDropsDashboard>({
			body: JSON.stringify({
				operationName: 'ViewerDropsDashboard',
				variables: {
					fetchRewardCampaigns: true,
				},
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: '5a4da2ab3d5b47c9f9ce864e727b2cb346af1e3ea8b897fe8f704a97ff017619',
					},
				},
			}),
		})
	}

	public async campaignDetails(data: CampaignDetail) {
		data.channelLogin = data.channelLogin ?? this.authState.user_id
		return super.graphql<DropCampaignDetails>({
			body: JSON.stringify({
				operationName: 'DropCampaignDetails',
				variables: data,
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: 'e7acdecb05429a62f5984bdcb27ee938ae20543579bf73c3ae44e7c822bc4f54',
					},
				},
			}),
		})
	}

	public async gameDirectory(slug: string) {
		return super.graphql<DirectoryPageGame>({
			body: JSON.stringify({
				operationName: 'DirectoryPage_Game',
				variables: {
					imageWidth: 50,
					slug,
					options: {
						includeRestricted: ['SUB_ONLY_LIVE'],
						sort: 'VIEWER_COUNT',
						recommendationsContext: {
							platform: 'web',
						},
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
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: 'c7c9d5aad09155c4161d2382092dc44610367f3536aac39019ec2582ae5065f9',
					},
				},
			}),
		})
	}

	public async inventory() {
		return super.graphql<Inventory>({
			body: JSON.stringify({
				operationName: 'Inventory',
				variables: {
					fetchRewardCampaigns: true,
				},
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: 'a16feb991626027918d26488d4e8a4a4110beb76a09062255280abdac6740dd4',
					},
				},
			}),
		})
	}

	public async channelPoints(channelLogin: string) {
		return super.graphql<ChannelPointsContext>({
			body: JSON.stringify({
				operationName: 'ChannelPointsContext',
				variables: { channelLogin },
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: '1530a003a7d374b0380b79db0be0534f30ff46e61cffa2bc0e2468a909fbc024',
					},
				},
			}),
		})
	}

	public async claimPoints({ channelID, claimID }: ClaimPoint) {
		return super.graphql<ClaimCommunityPointsMutation>({
			body: JSON.stringify({
				operationName: 'ClaimCommunityPointsMutation',
				variables: { input: { channelID, claimID } },
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: '3ee69ceb3cfa8c952d572968fc2571cbdf76760bca52c643772eb61c09281915',
					},
				},
			}),
		})
	}

	public async dropCurrent() {
		return super.graphql<DropCurrentSessionContext>({
			body: JSON.stringify({
				operationName: 'DropCurrentSessionContext',
				variables: {},
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: '4d06b702d25d652afb9ef835d2a550031f1cf762b193523a92166f40ea3d142b',
					},
				},
			}),
		})
	}

	public async claimDrops(dropInstanceId: string) {
		return super.graphql<ClaimDropRewardsMutation>({
			body: JSON.stringify({
				operationName: 'ClaimDropRewardsMutation',
				variables: { dropInstanceId },
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: '8beae4d57187980eb9a3db758dfb7c839adf01dae778a6599edbfbe2b2a00fe9',
					},
				},
			}),
		})
	}

	public async streamFetch(logins: string[]) {
		return super.graphql<FFZStreamFetch>({
			body: JSON.stringify({
				operationName: 'FFZ_StreamFetch',
				variables: { logins },
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: 'e3dbb5d8509ff2ef9d6518bf6749d2112bf6fc3ee2886248579bd7db0feb6504',
					},
				},
			}),
		})
	}
}

export interface CampaignDetail {
	dropID: string
	channelLogin?: string
}

export interface ClaimPoint {
	claimID: string
	channelID: string
}
