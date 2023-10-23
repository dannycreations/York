import { TwitchApi } from './TwitchApi'
import { Inventory } from './types/Inventory'
import { FFZStreamFetch } from './types/FFZStreamFetch'
import { AdRequestHandling } from './types/AdRequestHandling'
import { DirectoryPageGame } from './types/DirectoryPageGame'
import { DropCampaignDetails } from './types/DropCampaignDetails'
import { ChannelPointsContext } from './types/ChannelPointsContext'
import { ViewerDropsDashboard } from './types/ViewerDropsDashboard'
import { ClaimDropRewardsMutation } from './types/ClaimDropRewardsMutation'
import { DropCurrentSessionContext } from './types/DropCurrentSessionContext'
import { ClaimCommunityPointsMutation } from './types/ClaimCommunityPointsMutation'

export class TwitchGql extends TwitchApi {
	public constructor(access_token: string) {
		super(access_token)
	}

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
						sha256Hash: '821f91c947ab6e5a07d89ea1e1f9d0c834d354d636936bc3b43d77d4cff4fed8',
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
						sha256Hash: 'e5916665a37150808f8ad053ed6394b225d5504d175c7c0b01b9a89634c57136',
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
				},
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: '3c9a94ee095c735e43ed3ad6ce6d4cbd03c4c6f754b31de54993e0d48fd54e30',
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
						sha256Hash: '24de3977e178c431095279b6a95eaa01bf6a2203c97819b852f12702b817c0d8',
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
						sha256Hash: '2e4b3630b91552eb05b76a94b6850eb25fe42263b7cf6d06bee6d156dd247c1c',
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

	public async adRequest(login: string) {
		return super.graphql<AdRequestHandling>({
			body: JSON.stringify({
				operationName: 'AdRequestHandling',
				variables: {
					isLive: true,
					login,
					isVOD: false,
					vodID: '',
					isCollection: false,
					collectionID: '',
				},
				extensions: {
					persistedQuery: {
						version: 1,
						sha256Hash: '61a5ecca6da3d924efa9dbde811e051b8a10cb6bd0fe22c372c2f4401f3e88d1',
					},
				},
			}),
		})
	}

	public async streamFetch(logins: string[]) {
		if (!Array.isArray(logins)) throw 'Data must be array string!'
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
