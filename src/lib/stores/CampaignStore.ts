import { container } from '@vegapunk/core'
import { strictGet } from '@vegapunk/utilities'
import { sortBy } from '@vegapunk/utilities/common'
import { sleepForOf } from '@vegapunk/utilities/sleep'
import { Campaign } from '../struct/Campaign'
import { Drop } from '../struct/Drop'

export class CampaignStore {
	public get active(): Campaign[] {
		return this.values().filter((r) => !r.isStatus.expired && !r.isOffline)
	}

	public get sortedActive(): Campaign[] {
		const campaigns = sortBy(this.active, [(r) => r.endAt])
		for (let i = 0; i < campaigns.length; i++) {
			for (let j = i; j < campaigns.length; j++) {
				if (campaigns[i].game.id !== campaigns[j].game.id) continue
				if (campaigns[i].startAt < campaigns[j].startAt) continue

				const campaign = campaigns.splice(j, 1)[0]
				campaigns.splice(i, 0, campaign)
			}
		}
		return campaigns
	}

	public get offline(): Campaign[] {
		return this.values().filter((r) => r.isOffline)
	}

	public get sortedOffline(): Campaign[] {
		return sortBy(this.offline, [(r) => r.endAt])
	}

	public get upcoming(): Campaign[] {
		return this.values().filter((r) => r.isStatus.upcoming)
	}

	public get sortedUpcoming(): Campaign[] {
		return sortBy(this.upcoming, [(r) => r.startAt])
	}

	public delete(id: string): void {
		this.campaigns.delete(id)
	}

	public async getProgress(): Promise<void> {
		const inventory = await container.api.inventory()
		const dropRewards = strictGet(inventory, 'data.currentUser.inventory.gameEventDrops', [])
		const dropProgress = strictGet(inventory, 'data.currentUser.inventory.dropCampaignsInProgress', [])
		await Promise.all([
			sleepForOf(dropRewards, (data) => {
				const lastAwardedAt = new Date(data.lastAwardedAt)
				if (Date.now() - +lastAwardedAt >= this.rewardExpired) return

				const drop = { id: data.id, lastAwardedAt }
				Campaign.rewards.upsert((r) => r.id === drop.id, drop)
			}),
			sleepForOf(dropProgress, (campaign) => {
				const drops = campaign.timeBasedDrops
				return sleepForOf(drops, (data) => {
					const drop = new Drop({ campaignId: campaign.id, ...data })
					Campaign.progress.upsert((r) => r.id === drop.id, drop)
				})
			}),
		])
	}

	public async getCampaigns(): Promise<void> {
		const { config } = container.client

		const dropsDashboard = await container.api.dropsDashboard()
		const dropCampaigns = strictGet(dropsDashboard, 'data.currentUser.dropCampaigns', [])
		await sleepForOf(dropCampaigns, (data) => {
			const campaign = new Campaign(this, data)

			if (campaign.isStatus.expired) {
				this.campaigns.delete(campaign.id)
				return
			} else if (config.exclusionList.includes(campaign.game.displayName)) return
			else if (config.usePriorityConnected && campaign.isAccountConnected) {
				if (!config.priorityList.includes(campaign.game.displayName)) {
					config.priorityList.push(campaign.game.displayName)
				}
			}

			const isPriorityOnly = config.isDropPriorityOnly && config.priorityList.includes(campaign.game.displayName)
			if (isPriorityOnly || !config.isDropPriorityOnly) this.campaigns.set(campaign.id, campaign)
		})
	}

	private values() {
		return [...this.campaigns.values()]
	}

	private readonly campaigns = new Map<string, Campaign>()
	private readonly rewardExpired = 60_000 * 60 * 24 * 30 // 1 month
}
