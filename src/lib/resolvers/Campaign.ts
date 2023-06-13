import { sortBy } from 'lodash'
import { Inventory } from './Inventory'
import { container } from '@sapphire/pieces'
import { CampaignDetail } from '../api/TwitchGql'
import { RequiredExcept } from '@sapphire/utilities'
import { hasMobileAuth } from '../utils/common.util'
import { Game } from '../types/twitch/DropCampaignDetails'
import { checkStatus } from '../helpers/check-status.helper'
import { AbstractResolver } from './types/abstract.resolver'
import { TimeBasedDrop as InventoryDrop } from '../types/twitch/Inventory'

export class Campaign implements AbstractResolver {
	inventory = new Inventory()

	async fetch(force?: boolean): Promise<void> {
		if (force) await container.campaignRepository.nativeDelete({})
		if (await container.campaignRepository.count()) return

		const dropsDashboard = (await container.twitch.dropsDashboard()).at(0)
		const dropCampaigns = sortBy(dropsDashboard.data.currentUser.dropCampaigns, 'endAt')
		for (let i = 0; i < dropCampaigns.length; i++) {
			for (let j = i; j < dropCampaigns.length; j++) {
				if (dropCampaigns[i].game.id !== dropCampaigns[j].game.id) continue
				if (dropCampaigns[i].startAt <= dropCampaigns[j].startAt) continue

				const element = dropCampaigns.splice(j, 1).at(0)
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

			const campaignEntity = {
				id: campaign.id,
				name: campaign.name.trim(),
				game: campaign.game.displayName,
				startAt: campaign.startAt,
				endAt: campaign.endAt,
			}
			if (container.config.isDropPriorityOnly) {
				if (!!~container.config.priorityList.indexOf(campaign.game.displayName)) {
					container.campaignRepository.create(campaignEntity)
				}
				continue
			}

			container.campaignRepository.create(campaignEntity)
		}
	}

	async checkCampaign(campaign: CampaignDetail) {
		if (!this.inventory.isFetch) await this.inventory.fetch()
		const campaignDetails = (await container.twitch.campaignDetails(campaign)).at(0)

		const detail = campaignDetails.data.user.dropCampaign
		const campaignProgress = this.inventory.dropsProgress.find((r) => r.id === detail.id)
		const timeBasedDrops = (campaignProgress ? campaignProgress.timeBasedDrops : detail.timeBasedDrops) as TimeBasedDrop[]

		for (const drop of timeBasedDrops) {
			const isStatus = checkStatus(drop.startAt, drop.endAt)
			if (isStatus.expired) continue
			if (isStatus.upcoming) {
				container.campaignRepository.create({
					id: detail.id,
					name: detail.name.trim(),
					game: detail.game.displayName,
					startAt: drop.startAt,
					endAt: drop.endAt,
				})
				continue
			}

			const selectBenefit = drop.benefitEdges.at(0)
			if (drop.self) {
				if (drop.self.isClaimed) continue
				if (drop.self.currentMinutesWatched >= drop.requiredMinutesWatched) {
					if (!hasMobileAuth() || !container.config.isClaimDrops) continue
				}
			} else {
				if (!!~this.inventory.dropsClaimed.findIndex((r) => r.id === selectBenefit.benefit.id)) continue
			}

			drop.self = {
				isClaimed: false,
				dropInstanceID: null,
				currentMinutesWatched: 0,
				hasPreconditionsMet: true,
				...(drop.self as {}),
			}

			container.dropRepository.create({
				id: drop.id,
				name: drop.benefitEdges.at(0).benefit.name,
				dropInstanceId: drop.self.dropInstanceID,
				preconditionId: drop.preconditionDrops?.at(0).id,
				hasPreconditionsMet: drop.self.hasPreconditionsMet,
				currentMinutesWatched: drop.self.currentMinutesWatched,
				requiredMinutesWatched: drop.requiredMinutesWatched,
				startAt: drop.startAt,
				endAt: drop.endAt,
				campaign: detail.id,
			})
		}

		return this.getLive(detail.id, detail.game.displayName, detail.allow.channels)
	}

	private async getLive(campaign: string, gameName: string, whitelist: Game[] | null) {
		if (!whitelist?.length) {
			const gameDirectory = (await container.twitch.gameDirectory(gameName)).at(0)
			if (!gameDirectory.data.game?.streams) return

			for (const stream of gameDirectory.data.game.streams.edges) {
				const broadcast_id = stream.node.id
				const login = stream.node.broadcaster.login
				const channel_id = stream.node.broadcaster.id
				container.channelRepository.create({ login, channel_id, broadcast_id, campaign })
			}
		} else {
			const logins = whitelist.map((r) => r.name).slice(0, 30)
			const streamFetch = (await container.twitch.streamFetch(logins)).at(0)
			const filterSuspend = streamFetch.data.users.filter(Boolean)
			for (const user of filterSuspend) {
				if (!user.stream) continue

				const login = user.login
				const channel_id = user.id
				const broadcast_id = user.stream.id
				container.channelRepository.create({ login, channel_id, broadcast_id, campaign })
			}
		}
	}
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
		displayName: string
	}
	// drops: DropStore
	// channels: ChannelStore
}

export interface TimeBasedDrop extends RequiredExcept<InventoryDrop, 'self' | 'campaign'> {}
export interface ActiveTimeBasedDrop extends RequiredExcept<TimeBasedDrop, 'campaign'> {}
