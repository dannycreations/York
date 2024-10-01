import { container } from '@vegapunk/core'
import { _, RequiredExcept } from '@vegapunk/utilities'
import { ActiveLiveChannel } from '../api/TwitchApi'
import { CampaignDetail } from '../api/TwitchGql'
import { Game } from '../api/types/DropCampaignDetails'
import { DropCampaignsInProgress, GameEventDrop, TimeBasedDrop as InventoryDrop } from '../api/types/Inventory'
import { DropCampaign } from '../api/types/ViewerDropsDashboard'
import { ChannelStore } from '../stores/ChannelStore'
import { DropStore } from '../stores/DropStore'

export class Campaign {
	public games(games?: string[]) {
		if (Array.isArray(games)) {
			this.gameList = games
		}
		return this.gameList
	}

	public campaign(campaign?: DropCampaign[]) {
		if (Array.isArray(campaign)) {
			this.campaignList = campaign
		}
		return this.campaignList
	}

	public offline(offline?: Offline[]) {
		if (Array.isArray(offline)) {
			this.offlineList = offline
		}
		return this.offlineList
	}

	public upcoming(upcoming?: Upcoming[]) {
		if (Array.isArray(upcoming)) {
			this.upcomingList = upcoming
		}
		return this.upcomingList
	}

	public resetInventory() {
		this.isInventory = undefined
		this.dropsClaimed = []
		this.dropsProgress = []
	}

	public async fetchCampaign(force?: boolean) {
		if (force) this.campaignList = []
		if (this.campaignList.length) return

		const dropsDashboard = await container.twitch.dropsDashboard()
		const dropCampaigns = _.sortBy(dropsDashboard.data.currentUser.dropCampaigns, 'endAt')
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
			if (!!~container.client.config.exclusionList.indexOf(campaign.game.displayName)) continue
			if (container.client.config.usePriorityConnected && campaign.self.isAccountConnected) {
				if (!~container.client.config.priorityList.indexOf(campaign.game.displayName)) {
					container.client.config.priorityList.push(campaign.game.displayName)
				}
			}

			campaign.name = campaign.name.trim()
			if (isStatus.upcoming) {
				if (!~this.upcomingList.findIndex((r) => r.id === campaign.id)) {
					this.upcomingList.push(campaign)
				}
				continue
			}
			if (container.client.config.isDropPriorityOnly) {
				if (!!~container.client.config.priorityList.indexOf(campaign.game.displayName)) {
					this.campaignList.push(campaign)
				}
				continue
			}

			this.campaignList.push(campaign)
		}
	}

	public async fetchInventory() {
		const inventory = await container.twitch.inventory()
		this.dropsClaimed = inventory.data.currentUser.inventory.gameEventDrops
		this.dropsProgress = inventory.data.currentUser.inventory.dropCampaignsInProgress
		this.isInventory = true
	}

	public async checkCampaign(campaign: CampaignDetail): Promise<ActiveCampaign> {
		if (!this.isInventory) await this.fetchInventory()
		const campaignDetails = await container.twitch.campaignDetails(campaign)

		const detail = campaignDetails.data.user.dropCampaign
		const campaignProgress = this.dropsProgress.find((r) => r.id === detail.id)
		const timeBasedDrops = _.cloneDeep(campaignProgress ? campaignProgress.timeBasedDrops : detail.timeBasedDrops) as TimeBasedDrop[]
		const sortTimeBasedDrops = _.sortBy(timeBasedDrops, 'requiredMinutesWatched')

		const activeCampaign = {
			id: detail.id,
			name: detail.name.trim(),
			game: { ...detail.game },
			drops: new DropStore(),
			channels: new ChannelStore(detail.game.id),
		}

		const activeDrops: ActiveTimeBasedDrop[] = []
		for (const drop of sortTimeBasedDrops) {
			if (drop.requiredSubs > 0) continue

			drop.self = {
				isClaimed: false,
				dropInstanceID: null,
				currentMinutesWatched: 0,
				hasPreconditionsMet: true,
				...drop.self,
			}

			const minutesLeft = drop.requiredMinutesWatched - drop.self.currentMinutesWatched
			const isStatus = checkStatus(drop.startAt, drop.endAt, minutesLeft)
			if (isStatus.expired) continue
			if (isStatus.upcoming) {
				if (!~this.upcomingList.findIndex((r) => r.id === detail.id)) {
					this.upcomingList.push({ ...detail, startAt: drop.startAt, endAt: drop.endAt })
				}

				continue
			}

			const selectBenefit = drop.benefitEdges[0]
			if (drop.self) {
				if (drop.self.isClaimed) continue
				if (drop.self.currentMinutesWatched >= drop.requiredMinutesWatched) {
					if (!container.client.config.isClaimDrops) continue
				}
			} else {
				if (!!~this.dropsClaimed.findIndex((r) => r.id === selectBenefit.benefit.id)) continue
			}

			activeDrops.push(drop as ActiveTimeBasedDrop)
		}

		if (activeDrops.length) {
			for (let i = 0; i < activeDrops.length; i++) {
				const selectBenefit = activeDrops[i].benefitEdges[0]
				selectBenefit.benefit.name = `${i + 1}/${activeDrops.length}, ${selectBenefit.benefit.name.trim()}`
				activeCampaign.drops.enqueue(activeDrops[i])
			}

			const getLive = await this.getLive(detail.game.slug, detail.allow.channels)
			activeCampaign.channels.enqueueMany(getLive)
		}
		return activeCampaign
	}

	private async getLive(slug: string, channels: Game[] | null) {
		const foundLives: ActiveLiveChannel[] = []
		if (!channels?.length) {
			const gameDirectory = await container.twitch.gameDirectory(slug)
			if (!gameDirectory.data.game?.streams) return foundLives

			for (const stream of gameDirectory.data.game.streams.edges) {
				const login = stream.node.broadcaster.login
				const channel_id = stream.node.broadcaster.id
				foundLives.push({ login, channel_id })
			}
		} else {
			const logins = channels.map((r) => r.name).slice(0, 30)
			const streamFetch = await container.twitch.streamFetch(logins)
			const filterSuspend = streamFetch.data.users.filter(Boolean)
			for (const user of filterSuspend) {
				if (!user.stream) continue

				const login = user.login
				const channel_id = user.id
				foundLives.push({ login, channel_id })
			}
		}
		return foundLives
	}

	private gameList: string[] = []
	private offlineList: Offline[] = []
	private upcomingList: Upcoming[] = []
	private campaignList: DropCampaign[] = []

	private isInventory?: boolean
	private dropsClaimed: GameEventDrop[] = []
	private dropsProgress: DropCampaignsInProgress[] = []
}

export function checkStatus(startAt: string, endAt: string, minutesLeft: number = 0): Status {
	let [active, expired, upcoming] = new Array<boolean>(3).fill(false)
	const [currentDate, startDate, endDate, remainingDate] = [
		new Date(),
		new Date(startAt),
		new Date(endAt),
		new Date(Date.now() + (minutesLeft + 10) * 1000),
	]

	if (currentDate > startDate && currentDate < endDate && remainingDate < endDate) active = true
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
