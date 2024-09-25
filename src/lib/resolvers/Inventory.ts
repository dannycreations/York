import { container } from '@vegapunk/core'
import { TwitchGql } from '../api/TwitchGql'
import { checkStatus } from '../helpers/campaign.helper'
import { AbstractResolver } from './types/abstract.resolver'

export class Inventory implements AbstractResolver {
	public static readonly Instance = new Inventory()

	public async fetch() {
		const inventory = await TwitchGql.Instance.inventory()
		for (const drop of inventory.data.currentUser.inventory.gameEventDrops) {
			container.dropRepository.create({
				id: drop.id,
				name: drop.name,
				status: 'claimed',
			})
		}

		for (const campaign of inventory.data.currentUser.inventory.dropCampaignsInProgress) {
			for (const drop of campaign.timeBasedDrops) {
				container.dropRepository.create({
					id: drop.id,
					name: drop.benefitEdges[0].benefit.name,
					status: 'progress',
					state: checkStatus(drop.startAt, drop.endAt),
					dropInstanceId: drop.self.dropInstanceID,
					preconditionId: drop.preconditionDrops?.[0].id,
					hasPreconditionsMet: drop.self.hasPreconditionsMet,
					currentMinutesWatched: drop.self.currentMinutesWatched,
					requiredMinutesWatched: drop.requiredMinutesWatched,
					startAt: drop.startAt,
					endAt: drop.endAt,
					campaignId: campaign.id,
				})
			}
		}

		this.isFetch = true
	}

	public async reset() {
		this.isFetch = false
		await container.dropRepository.nativeDelete({ status: { $ne: 'new' } })
	}

	public isFetched() {
		return this.isFetch
	}

	public async hasClaimed(id: string) {
		return !!(await container.dropRepository.count({ id, status: 'claimed' }))
	}

	public async hasProgress(id: string) {
		return !!(await container.dropRepository.count({ id, status: 'progress' }))
	}

	private isFetch: boolean
}
