import { container } from '@sapphire/pieces'
import { RequiredExcept } from '@sapphire/utilities'
import { cloneDeep, sortBy } from 'lodash'
import { ActiveLiveChannel } from '../api/TwitchApi'
import { CampaignDetail } from '../api/TwitchGql'
import { Game } from '../api/types/DropCampaignDetails'
import { DropCampaignsInProgress, GameEventDrop, TimeBasedDrop as InventoryDrop } from '../api/types/Inventory'
import { DropCampaign } from '../api/types/ViewerDropsDashboard'
import { ChannelStore } from '../stores/ChannelStore'
import { DropStore } from '../stores/DropStore'

export class Campaign {
	private _gameList: string[] = []
	private _offlineList: Offline[] = []
	private _upcomingList: Upcoming[] = []
	private _campaignList: DropCampaign[] = []

	private _isInventory?: boolean
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

	public resetInventory(): void {
		delete this._isInventory
		this._dropsClaimed = []
		this._dropsProgress = []
	}

	public async fetchCampaign(force?: boolean): Promise<void> {
		if (force) this._campaignList = []
		if (this._campaignList.length) return

		const dropsDashboard = await container.twitch.dropsDashboard()
		const dropCampaigns = sortBy(dropsDashboard.data.currentUser.dropCampaigns, 'endAt')
		for (let i = 0; i < dropCampaigns.length; i++) {
			for (let j = i; j < dropCampaigns.length; j++) {
				if (dropCampaigns[i].game.id !== dropCampaigns[j].game.id) continue
				if (dropCampaigns[i].startAt <= dropCampaigns[j].startAt) continue

				const element = dropCampaigns.splice(j, 1)[0]
				dropCampaigns.splice(i, 0, element)
			}
		}

		for (const campaign of dropCampaigns) {
			const isStatus = checkStatus(campaign.startAt, campaign.endAt)
			if (isStatus.expired) continue
			if (!!~container.config.exclusionList.indexOf(campaign.game.displayName)) continue
			if (container.config.usePriorityConnected && campaign.self.isAccountConnected) {
				if (!~container.config.priorityList.indexOf(campaign.game.displayName)) {
					container.config.priorityList.push(campaign.game.displayName)
				}
			}

			campaign.name = campaign.name.trim()
			if (isStatus.upcoming) {
				if (!~this._upcomingList.findIndex((r) => r.id === campaign.id)) {
					this._upcomingList.push(campaign)
				}
				continue
			}
			if (container.config.isDropPriorityOnly) {
				if (!!~container.config.priorityList.indexOf(campaign.game.displayName)) {
					this._campaignList.push(campaign)
				}
				continue
			}

			this._campaignList.push(campaign)
		}
	}

	public async fetchInventory(): Promise<void> {
		const inventory = await container.twitch.inventory()
		this._dropsClaimed = inventory.data.currentUser.inventory.gameEventDrops
		this._dropsProgress = inventory.data.currentUser.inventory.dropCampaignsInProgress
		this._isInventory = true
	}

	public async checkCampaign(campaign: CampaignDetail): Promise<ActiveCampaign> {
		if (!this._isInventory) await this.fetchInventory()
		const campaignDetails = await container.twitch.campaignDetails(campaign)

		const detail = campaignDetails.data.user.dropCampaign
		const campaignProgress = this._dropsProgress.find((r) => r.id === detail.id)
		const timeBasedDrops = cloneDeep(campaignProgress ? campaignProgress.timeBasedDrops : detail.timeBasedDrops) as TimeBasedDrop[]
		const sortTimeBasedDrops = sortBy(timeBasedDrops, 'requiredMinutesWatched')

		const activeCampaign = {
			id: detail.id,
			name: detail.name.trim(),
			game: { ...detail.game },
			drops: new DropStore(),
			channels: new ChannelStore(detail.game.id),
		}

		const activeDrops: ActiveTimeBasedDrop[] = []
		for (const drop of sortTimeBasedDrops) {
			const isStatus = checkStatus(drop.startAt, drop.endAt)
			if (isStatus.expired) continue
			if (isStatus.upcoming) {
				if (!~this._upcomingList.findIndex((r) => r.id === detail.id)) {
					this._upcomingList.push({ ...detail, startAt: drop.startAt, endAt: drop.endAt })
				}

				continue
			}

			const selectBenefit = drop.benefitEdges[0]
			if (drop.self) {
				if (drop.self.isClaimed) continue
				if (drop.self.currentMinutesWatched >= drop.requiredMinutesWatched) {
					if (!container.config.isClaimDrops) continue
				}
			} else {
				if (!!~this._dropsClaimed.findIndex((r) => r.id === selectBenefit.benefit.id)) continue
			}

			drop.self = {
				isClaimed: false,
				dropInstanceID: null,
				currentMinutesWatched: 0,
				hasPreconditionsMet: true,
				...(drop.self as {}),
			}

			activeDrops.push(drop as ActiveTimeBasedDrop)
		}
		if (!activeDrops.length) return activeCampaign

		for (let i = 0; i < activeDrops.length; i++) {
			const selectBenefit = activeDrops[i].benefitEdges[0]
			selectBenefit.benefit.name = `${i + 1}/${activeDrops.length}, ${selectBenefit.benefit.name.trim()}`
			activeCampaign.drops.enqueue(activeDrops[i])
		}

		if (detail.allow.isEnabled) {
			const getLive = await this.getLive(detail.game.slug, detail.allow.channels)
			activeCampaign.channels.enqueueMany(getLive)
		}
		return activeCampaign
	}

	private async getLive(slug: string, channels: Game[] | null): Promise<ActiveLiveChannel[]> {
		const foundLives: ActiveLiveChannel[] = []
		if (!channels?.length) {
			const gameDirectory = await container.twitch.gameDirectory(slug)
			if (!gameDirectory.data.game?.streams) return foundLives

			for (const stream of gameDirectory.data.game.streams.edges) {
				const broadcast_id = stream.node.id
				const login = stream.node.broadcaster.login
				const channel_id = stream.node.broadcaster.id
				foundLives.push({ login, channel_id, broadcast_id })
			}
		} else {
			const logins = channels.map((r) => r.name).slice(0, 30)
			const streamFetch = await container.twitch.streamFetch(logins)
			const filterSuspend = streamFetch.data.users.filter(Boolean)
			for (const user of filterSuspend) {
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

export interface Upcoming extends Omit<ActiveCampaign, 'drops' | 'channels'> {
	startAt: string
	endAt: string
}

export interface ActiveCampaign {
	id: string
	name: string
	game: {
		id: string
		displayName?: string
		name?: string
		slug?: string
	}
	drops: DropStore
	channels: ChannelStore
}

export interface TimeBasedDrop extends RequiredExcept<InventoryDrop, 'self' | 'campaign'> {}
export interface ActiveTimeBasedDrop extends RequiredExcept<TimeBasedDrop, 'campaign'> {}
