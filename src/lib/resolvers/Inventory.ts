import { container } from '@sapphire/pieces'
import { DropCampaign } from '../api/types/DropCampaignDetails'
import { BenefitEdge, DropCampaignsInProgress, GameEventDrop } from '../api/types/Inventory'
import { AbstractResolver } from './types/abstract.resolver'

export class Inventory implements AbstractResolver {
	public async fetch() {
		const inventory = await container.twitch.inventory()
		this.dropsClaimed = inventory.data.currentUser.inventory.gameEventDrops
		this.dropsProgress = inventory.data.currentUser.inventory.dropCampaignsInProgress
		this.isFetch = true
	}

	public reset() {
		this.isFetch = false
		this.dropsClaimed = []
		this.dropsProgress = []
	}

	public isFetched() {
		return this.isFetch
	}

	public hasClaimed(query: BenefitEdge) {
		return !!~this.dropsClaimed.findIndex((r) => r.id === query.benefit.id)
	}

	public findProgress(query: DropCampaign) {
		return this.dropsProgress.find((r) => r.id === query.id)
	}

	private isFetch: boolean
	private dropsClaimed: GameEventDrop[] = []
	private dropsProgress: DropCampaignsInProgress[] = []
}
