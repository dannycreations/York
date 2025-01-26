import { container } from '@vegapunk/core'
import { chalk, strictGet, truncate } from '@vegapunk/utilities'
import { sortBy } from '@vegapunk/utilities/common'
import { sleepForOf } from '@vegapunk/utilities/sleep'
import { GqlQuery } from '../api/TwitchGql'
import { ChannelDrops } from '../api/types/ChannelDrops'
import { DropCampaign } from '../api/types/DropsDashboard'
import { DropStatus, dropStatus } from '../helpers/time.helper'
import { CampaignStore } from '../stores/CampaignStore'
import { Queue } from '../stores/internal/Queue'
import { Channel } from './Channel'
import { Drop } from './Drop'

export class Campaign {
	public static readonly progress: Queue<Drop> = new Queue()
	public static readonly rewards: Queue<Reward> = new Queue()
	public static trackMinutesWatched = 0

	public readonly id: string
	public readonly name: string
	public readonly game: Game
	public readonly startAt: Date
	public readonly endAt: Date
	public readonly isAccountConnected: boolean

	public readonly drops: Queue<Drop> = new Queue()
	public readonly channels: Queue<Channel> = new Queue()

	public isOffline = false

	public constructor(private store: CampaignStore, campaign: DropCampaign) {
		this.id = campaign.id
		this.name = campaign.name.trim()
		this.game = campaign.game as Game
		this.startAt = new Date(campaign.startAt)
		this.endAt = new Date(campaign.endAt)
		this.isAccountConnected = campaign.self.isAccountConnected
	}

	public get isStatus(): DropStatus {
		return dropStatus(this.startAt, this.endAt)
	}

	public async watch(): Promise<boolean> {
		const selectDrop = this.drops.peek()
		if (!selectDrop) return false

		const selectChannel = this.channels.peek()
		if (!selectChannel) return false

		const watch = await selectChannel.watch()
		if (watch) {
			const localMinutesWatched = ++selectDrop.currentMinutesWatched
			const currentProgress = chalk`{green ${localMinutesWatched}/${selectDrop.requiredMinutesWatched}}`
			container.logger.info(chalk`{green ${selectDrop.name}} | {green ${truncate(selectChannel.login)}} | ${currentProgress}`)

			if (Campaign.trackMinutesWatched >= 20) {
				Campaign.trackMinutesWatched = 0

				await this.store.getProgress()
				await this.getDrops()
				if (localMinutesWatched - selectDrop.currentMinutesWatched >= 20) {
					selectChannel.isOnline = false
				}
			}
		}

		if (!selectChannel.isOnline) {
			this.channels.dequeue()
		}
		return watch
	}

	public async claimDrops(): Promise<boolean> {
		const selectDrop = this.drops.peek()
		if (!selectDrop) return false

		const claim = await selectDrop.claimDrops()
		if (claim) {
			Campaign.progress.delete((r) => r.id === selectDrop.id)
			await sleepForOf(selectDrop.benefits, (id) => {
				const drop = { id, lastAwardedAt: new Date() }
				Campaign.rewards.upsert((r) => r.id === drop.id, drop)
			})
		}
		return claim
	}

	public async getDrops(): Promise<void> {
		const campaignDetail = await container.api.campaignDetails({ dropID: this.id })
		const dropDetail = strictGet(campaignDetail, 'data.user.dropCampaign')
		if (!dropDetail) return

		this.allowChannels = dropDetail.allow.channels?.map((r) => r.name) ?? []
		Object.assign(this, { name: dropDetail.name.trim(), game: { ...dropDetail.game } })

		const activeDrops: Drop[] = []
		const sortedTimeBasedDrops = sortBy(dropDetail.timeBasedDrops, [(r) => r.requiredMinutesWatched])
		await sleepForOf(sortedTimeBasedDrops, (data) => {
			const exist = Campaign.progress.find((r) => r.id === data.id)
			const drop = exist ?? new Drop({ campaignId: this.id, ...data })

			if (drop.isStatus.expired) return
			if (drop.isStatus.upcoming) return
			if (drop.isMinutesWatchedMet && !container.client.config.isClaimDrops) return
			if (!exist && drop.benefits.some((r) => this.isClaimed(r, drop.startAt))) return

			activeDrops.push(drop)
		})
		await sleepForOf(activeDrops, (drop, i) => {
			Object.assign(drop, { name: truncate(`${i + 1}/${activeDrops.length}, ${drop.name}`) })
			this.drops.upsert((r) => r.id === drop.id, drop)
		})
	}

	public async getChannels(): Promise<void> {
		const gameId = this.game.id
		const foundChannels: Channel[] = []
		if (this.allowChannels?.length) {
			const logins = this.allowChannels.slice(0, 30)
			const stream = await container.api.channelStreams(logins)
			const users = strictGet(stream, 'data.users', [])
			await sleepForOf(users, (user) => {
				if (!user?.stream) return

				const id = user.id
				const login = user.login
				const channel = new Channel({ id, login, gameId })
				foundChannels.push(channel)
			})
		} else {
			const directory = await container.api.gameDirectory(this.game.slug)
			const users = strictGet(directory, 'data.game.streams.edges', [])
			await sleepForOf(users, (user) => {
				const id = user.node.broadcaster.id
				const login = user.node.broadcaster.login
				const channel = new Channel({ id, login, gameId })
				foundChannels.push(channel)
			})
		}

		if (!foundChannels.length) return

		const channel = await container.api.graphql<ChannelDrops>(foundChannels.map((r) => GqlQuery.channelDrops(r.id)))
		const channelFilter = channel.filter((r) => r.data.channel.viewerDropCampaigns?.some((r) => r.id === this.id))
		this.channels.enqueueMany(foundChannels.filter((r) => channelFilter.some((s) => s.data.channel.id === r.id)))
	}

	private isClaimed(benefitId: string, startAt: Date) {
		const reward = Campaign.rewards.find((r) => r.id === benefitId)
		return reward ? reward.lastAwardedAt >= startAt : false
	}

	private allowChannels?: string[]
}

export interface Reward {
	id: string
	lastAwardedAt: Date
}

export interface Game {
	id: string
	name: string
	slug: string
	displayName: string
}
