import { TwitchApi } from './TwitchApi'
import { Constants } from '../types/Enum'
import { Inventory } from '../types/twitch/Inventory'
import { FFZStreamFetch } from '../types/twitch/FFZStreamFetch'
import { AdRequestHandling } from '../types/twitch/AdRequestHandling'
import { DirectoryPageGame } from '../types/twitch/DirectoryPageGame'
import { DropCampaignDetails } from '../types/twitch/DropCampaignDetails'
import { ChannelPointsContext } from '../types/twitch/ChannelPointsContext'
import { ViewerDropsDashboard } from '../types/twitch/ViewerDropsDashboard'
import { ClaimDropRewardsMutation } from '../types/twitch/ClaimDropRewardsMutation'
import { DropCurrentSessionContext } from '../types/twitch/DropCurrentSessionContext'
import { ClaimCommunityPointsMutation } from '../types/twitch/ClaimCommunityPointsMutation'

export class TwitchGql extends TwitchApi {
	constructor(access_token: string) {
		super(access_token)
	}

	public async dropsDashboard() {
		const request = {
			key: 'ViewerDropsDashboard',
			hash: 'e8b98b52bbd7ccd37d0b671ad0d47be5238caa5bea637d2a65776175b4a23a64'
		}

		super.add(request)
		return super.graphql<ViewerDropsDashboard>()
	}

	public async campaignDetails(data: CampaignDetail | CampaignDetail[]) {
		const request = {
			key: 'DropCampaignDetails',
			hash: 'f6396f5ffdde867a8f6f6da18286e4baf02e5b98d14689a69b5af320a4c7b7b8'
		}

		if (Array.isArray(data)) {
			for (const campaign of data) {
				campaign.channelLogin = campaign.channelLogin ?? this.authState.user_id
				super.add({ ...request, data: campaign })
			}
		} else {
			data.channelLogin = data.channelLogin ?? this.authState.user_id
			super.add({ ...request, data })
		}
		return super.graphql<DropCampaignDetails>()
	}

	public async gameDirectory(name: string) {
		const request = {
			key: 'DirectoryPage_Game',
			hash: 'd5c5df7ab9ae65c3ea0f225738c08a36a4a76e4c6c31db7f8c4b8dc064227f9e',
			data: {
				name,
				limit: 30,
				options: {
					includeRestricted: ['SUB_ONLY_LIVE'],
					recommendationsContext: { platform: 'web' },
					sort: 'RELEVANCE',
					tags: [Constants.DropTag],
					requestID: 'JIRA-VXP-2397',
					freeformTags: ['DropsEnabled']
				},
				sortTypeIsRecency: false
			}
		}

		super.add(request)
		return super.graphql<DirectoryPageGame>()
	}

	public async inventory() {
		const request = {
			key: 'Inventory',
			hash: '27f074f54ff74e0b05c8244ef2667180c2f911255e589ccd693a1a52ccca7367'
		}

		super.add(request)
		return super.graphql<Inventory>()
	}

	public async channelPoints(channelLogin: string) {
		const request = {
			key: 'ChannelPointsContext',
			hash: '1530a003a7d374b0380b79db0be0534f30ff46e61cffa2bc0e2468a909fbc024',
			data: { channelLogin }
		}

		super.add(request)
		return super.graphql<ChannelPointsContext>()
	}

	public async claimPoints({ channelID, claimID }: ClaimPoint) {
		const request = {
			key: 'ClaimCommunityPointsMutation',
			hash: '3ee69ceb3cfa8c952d572968fc2571cbdf76760bca52c643772eb61c09281915',
			data: { input: { channelID, claimID } }
		}

		super.add(request)
		const options = this.useMobileAuth()
		return super.graphql<ClaimCommunityPointsMutation>(options)
	}

	public async dropCurrent() {
		const request = {
			key: 'DropCurrentSessionContext',
			hash: '2e4b3630b91552eb05b76a94b6850eb25fe42263b7cf6d06bee6d156dd247c1c'
		}

		super.add(request)
		return super.graphql<DropCurrentSessionContext>()
	}

	public async claimDrops(dropInstanceId: string) {
		const request = {
			key: 'ClaimDropRewardsMutation',
			hash: '8beae4d57187980eb9a3db758dfb7c839adf01dae778a6599edbfbe2b2a00fe9',
			data: { dropInstanceId }
		}

		super.add(request)
		const options = this.useMobileAuth()
		return super.graphql<ClaimDropRewardsMutation>(options)
	}

	public async adRequest(login: string) {
		const request = {
			key: 'AdRequestHandling',
			hash: '3ad9132d1738b06958e16134a8f98d82ff6d9956357b4feaecba48ad8feaa88b',
			data: {
				login,
				isLive: true,
				isVOD: false,
				vodID: '',
				isCollection: false,
				collectionID: ''
			}
		}

		super.add(request)
		return super.graphql<AdRequestHandling>()
	}

	public async streamFetch(logins: string[]) {
		if (!Array.isArray(logins)) throw 'Data must be array string!'

		const request = {
			key: 'FFZ_StreamFetch',
			hash: 'e3dbb5d8509ff2ef9d6518bf6749d2112bf6fc3ee2886248579bd7db0feb6504',
			data: { logins }
		}

		super.add(request)
		return super.graphql<FFZStreamFetch>()
	}

	/**
	 * ! Temp fix: Bypass integrity check
	 */
	private useMobileAuth() {
		return {
			headers: {
				Authorization: `OAuth ${process.env.AUTH_TOKEN_MOBILE}`,
				'Client-Id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp'
			}
		}
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
