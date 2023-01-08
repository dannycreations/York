import { sortBy } from 'lodash'
import { container } from '@sapphire/pieces'
import { hasMobileAuth } from '../utils/util'
import { DropStore } from '../stores/DropStore'
import { CampaignDetail } from '../api/TwitchGql'
import { ActiveLiveChannel } from '../api/TwitchApi'
import { RequiredExcept } from '@sapphire/utilities'
import { ChannelStore } from '../stores/ChannelStore'
import { Game } from '../types/twitch/DropCampaignDetails'
import { DropCampaign } from '../types/twitch/ViewerDropsDashboard'
import { TimeBasedDrop as InventoryDrop } from '../types/twitch/Inventory'
import { DropCampaignsInProgress, GameEventDrop } from '../types/twitch/Inventory'

export class Campaign {
	private _gameList: string[] = []
	private _offlineList: Offline[] = []
	private _upcomingList: Upcoming[] = []
	private _campaignList: DropCampaign[] = []

	private _isInventory: boolean = false
	private _dropsClaimed: GameEventDrop[] = []
	private _dropsProgress: DropCampaignsInProgress[] = []

	public gameList(gameList?: string[]): string[] {
		if (Array.isArray(gameList)) {
			this._gameList = gameList
		}
		return this._gameList
	}

	public campaignList(campaign?: DropCampaign[]): DropCampaign[] {
		if (Array.isArray(campaign)) {
			this._campaignList = campaign
		}
		return this._campaignList
	}

	public offlineList(offline?: Offline[]): Offline[] {
		if (Array.isArray(offline)) {
			this._offlineList = offline
		}
		return this._offlineList
	}

	public upcomingList(upcoming?: Upcoming[]): Upcoming[] {
		if (Array.isArray(upcoming)) {
			this._upcomingList = upcoming
		}
		return this._upcomingList
	}

	public async fetchCampaign(force?: boolean): Promise<void> {
		if (force) this._campaignList.length = 0
		if (this._campaignList.length) return

		const dropsDashboard = (await container.twitch.dropsDashboard())[0]
		const dropCampaigns = sortBy(dropsDashboard.data.currentUser.dropCampaigns, 'startAt')
		for (const campaign of dropCampaigns) {
			const isStatus = checkStatus(campaign.startAt, campaign.endAt)
			if (isStatus.expired) continue
			if (!!~container.config.exclusionList.indexOf(campaign.game.displayName)) continue
			if (container.config.isDropPriorityOnly) continue
			if (container.config.isDropConnectedOnly) {
				if (!campaign.self.isAccountConnected) continue
			}
			if (isStatus.upcoming) {
				if (this._upcomingList.find((r) => r.id === campaign.id)) continue

				const id = campaign.id
				const startAt = campaign.startAt
				const game = campaign.game.displayName
				this._upcomingList.push({ id, game, startAt })
				continue
			}
			this._campaignList.push(campaign)
		}
	}

	public async fetchInventory(): Promise<void> {
		const inventory = (await container.twitch.inventory())[0]
		this._dropsClaimed = inventory.data.currentUser.inventory.gameEventDrops
		this._dropsProgress = inventory.data.currentUser.inventory.dropCampaignsInProgress
		this._isInventory = true
	}

	public async checkCampaign(campaign: CampaignDetail, force?: boolean): Promise<ActiveCampaign> {
		if (force || !this._isInventory) await this.fetchInventory()
		const campaignDetails = (await container.twitch.campaignDetails(campaign))[0]

		const detail = campaignDetails.data.user.dropCampaign
		const campaignProgress = this._dropsProgress.find((r) => r.id === detail.id)
		const timeBasedDrops = (campaignProgress ? campaignProgress.timeBasedDrops : detail.timeBasedDrops) as TimeBasedDrop[]

		const activeCampaign = {
			id: detail.id,
			name: detail.name,
			game: detail.game.displayName,
			drops: new DropStore(),
			channels: new ChannelStore(detail.game.id)
		}

		let countDrops = 1
		for (const drop of timeBasedDrops) {
			const isStatus = checkStatus(drop.startAt, drop.endAt)
			if (isStatus.expired) continue
			if (isStatus.upcoming) {
				if (this._upcomingList.find((r) => r.id === detail.id)) continue

				const id = detail.id
				const startAt = drop.startAt
				const game = detail.game.displayName
				this._upcomingList.push({ id, game, startAt })
				continue
			}

			const selectBenefit = drop.benefitEdges[0]
			if (drop.self) {
				if (drop.self.isClaimed) continue
				if (drop.self.currentMinutesWatched >= drop.requiredMinutesWatched) {
					if (!hasMobileAuth() || !container.config.isClaimDrops) continue
				}
			} else {
				if (this._dropsClaimed.find((r) => r.id === selectBenefit.benefit.id)) continue
			}

			selectBenefit.benefit.name = `Drop ${countDrops++}, ${selectBenefit.benefit.name}`

			drop.self = {
				isClaimed: false,
				dropInstanceID: null,
				currentMinutesWatched: 0,
				hasPreconditionsMet: true,
				...(drop.self as {})
			}

			activeCampaign.drops.enqueue(drop as ActiveTimeBasedDrop)
		}
		if (!activeCampaign.drops.peek()) return activeCampaign

		activeCampaign.channels.enqueueMany(await this.getLive(detail.game.displayName, detail.allow.channels))
		return activeCampaign
	}

	private async getLive(gameName: string, whitelist: Game[] | null): Promise<ActiveLiveChannel[]> {
		const foundLives: ActiveLiveChannel[] = []
		if (!whitelist?.length) {
			const gameDirectory = (await container.twitch.gameDirectory(gameName))[0]
			if (!gameDirectory.data.game.streams) return foundLives

			for (const stream of gameDirectory.data.game.streams.edges) {
				const broadcast_id = stream.node.id
				const login = stream.node.broadcaster.login
				const channel_id = stream.node.broadcaster.id
				foundLives.push({ login, channel_id, broadcast_id })
			}
		} else {
			const streamFetch = (await container.twitch.streamFetch(whitelist.map((r) => r.name)))[0]
			for (const user of streamFetch.data.users) {
				if (!user.stream) continue

				const login = user.login
				const channel_id = user.id
				const broadcast_id = user.stream.id
				foundLives.push({ login, channel_id, broadcast_id })
			}
		}

		return foundLives
	}
}

export function checkStatus(startAt: string, endAt: string): Status {
	let [active, expired, upcoming] = new Array(3).fill(false) as boolean[]
	const [currentDate, startDate, endDate] = [new Date(), new Date(startAt), new Date(endAt)]
	if (currentDate > startDate && currentDate < endDate) active = true
	else if (currentDate <= startDate) upcoming = true
	else expired = true

	return { active, expired, upcoming }
}

export interface Status {
	active: boolean
	expired: boolean
	upcoming: boolean
}

export interface Offline {
	id: string
	game: string
}

export interface Upcoming {
	id: string
	game: string
	startAt: string
}

export interface ActiveCampaign {
	id: string
	name: string
	game: string
	drops: DropStore
	channels: ChannelStore
}

export interface TimeBasedDrop extends RequiredExcept<InventoryDrop, 'self' | 'campaign'> {}
export interface ActiveTimeBasedDrop extends RequiredExcept<TimeBasedDrop, 'campaign'> {}
