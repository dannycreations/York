import { container } from '@sapphire/pieces'
import { RequiredExcept } from '@sapphire/utilities'
import { sortBy } from 'lodash'
import { YorkClient } from '../YorkClient'
import { CampaignDetail, TwitchGql } from '../api/TwitchGql'
import { Game } from '../api/types/DropCampaignDetails'
import { TimeBasedDrop as InventoryDrop } from '../api/types/Inventory'
import { checkStatus } from '../helpers/campaign.helper'
import { Inventory } from './Inventory'
import { AbstractResolver } from './types/abstract.resolver'

export class Campaign implements AbstractResolver {
	public static readonly Instance = new Campaign()

	public async fetch(force?: boolean) {
		if (force) await this.reset()
		if (await container.campaignRepository.count()) return

		const dropsDashboard = await TwitchGql.Instance.dropsDashboard()
		const dropCampaigns = sortBy(dropsDashboard.data.currentUser.dropCampaigns, 'endAt')

		for (let i = 0; i < dropCampaigns.length; i++) {
			for (let j = i; j < dropCampaigns.length; j++) {
				if (dropCampaigns[i].game.id !== dropCampaigns[j].game.id) continue
				if (dropCampaigns[i].startAt <= dropCampaigns[j].startAt) continue

				const element = dropCampaigns.splice(j, 1).at(0)
				dropCampaigns.splice(i, 0, element)
			}
		}

		const config = (container.client as YorkClient).config

		for (const campaign of dropCampaigns) {
			const isStatus = checkStatus(campaign.startAt, campaign.endAt)
			if (isStatus.expired) continue
			if (!!~config.exclusionList.indexOf(campaign.game.displayName)) continue
			if (config.usePriorityConnected && campaign.self.isAccountConnected) {
				if (!~config.priorityList.indexOf(campaign.game.displayName)) {
					config.priorityList.push(campaign.game.displayName)
				}
			}

			const campaignEntity = {
				id: campaign.id,
				name: campaign.name.trim(),
				game: campaign.game.displayName,
				startAt: campaign.startAt,
				endAt: campaign.endAt,
			}

			if (config.isDropPriorityOnly) {
				if (!!~config.priorityList.indexOf(campaign.game.displayName)) {
					container.campaignRepository.create(campaignEntity)
				}
				continue
			}

			container.campaignRepository.create(campaignEntity)
		}
	}

	public async reset() {
		await Promise.all([
			container.campaignRepository.nativeDelete({}),
			container.dropRepository.nativeDelete({}),
			container.channelRepository.nativeDelete({}),
		])
	}

	public async checkCampaign(campaign: CampaignDetail) {
		if (!Inventory.Instance.isFetched()) {
			await Inventory.Instance.fetch()
		}

		const campaignDetail = await TwitchGql.Instance.campaignDetails(campaign)
		const dropCampaign = campaignDetail.data.user.dropCampaign
		if (!dropCampaign.allow.isEnabled) return

		const timeBasedDrops = dropCampaign.timeBasedDrops as unknown as TimeBasedDrop[]
		const sortTimeBasedDrops = sortBy(timeBasedDrops, 'requiredMinutesWatched')

		const config = (container.client as YorkClient).config

		for (const drop of sortTimeBasedDrops) {
			const isStatus = checkStatus(drop.startAt, drop.endAt)
			if (isStatus.expired) continue
			if (isStatus.upcoming) {
				container.campaignRepository.create({
					id: dropCampaign.id,
					name: dropCampaign.name.trim(),
					game: dropCampaign.game.displayName,
					startAt: drop.startAt,
					endAt: drop.endAt,
				})
				continue
			}

			const game = drop.benefitEdges.at(0).benefit
			if (drop.self) {
				if (drop.self.isClaimed) continue
				if (drop.self.currentMinutesWatched >= drop.requiredMinutesWatched) {
					if (!config.isClaimDrops) continue
				}
			} else {
				if (Inventory.Instance.hasClaimed(game.id)) continue
				if (Inventory.Instance.hasProgress(game.id)) continue
			}

			container.dropRepository.create({
				id: drop.id,
				name: game.name,
				dropInstanceId: drop.self.dropInstanceID,
				preconditionId: drop.preconditionDrops?.at(0).id,
				hasPreconditionsMet: drop.self.hasPreconditionsMet,
				currentMinutesWatched: drop.self.currentMinutesWatched,
				requiredMinutesWatched: drop.requiredMinutesWatched,
				startAt: drop.startAt,
				endAt: drop.endAt,
				campaignId: dropCampaign.id,
			})
		}

		const slug = dropCampaign.game.slug
		const channels = dropCampaign.allow.channels
		await this.getLive(slug, channels, dropCampaign.id)
	}

	private async getLive(slug: string, channels: Game[] | null, campaignId: string) {
		if (channels?.length) {
			const logins = channels.map((r) => r.name).slice(0, 30)
			const streamFetch = await TwitchGql.Instance.streamFetch(logins)
			const filterSuspend = streamFetch.data.users.filter((r) => r?.stream)

			for (const user of filterSuspend) {
				container.channelRepository.create({
					login: user.login,
					channelId: user.id,
					broadcastId: user.stream.id,
					campaignId: campaignId,
				})
			}
		} else {
			const gameDirectory = await TwitchGql.Instance.gameDirectory(slug)
			if (!gameDirectory.data.game?.streams) return

			for (const stream of gameDirectory.data.game.streams.edges) {
				container.channelRepository.create({
					login: stream.node.broadcaster.login,
					channelId: stream.node.broadcaster.id,
					broadcastId: stream.node.id,
					campaignId: campaignId,
				})
			}
		}
	}
}

export interface TimeBasedDrop extends RequiredExcept<InventoryDrop, 'self' | 'campaign'> {}
export interface ActiveTimeBasedDrop extends RequiredExcept<TimeBasedDrop, 'campaign'> {}
