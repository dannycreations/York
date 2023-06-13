import { container } from '@sapphire/pieces'
import { DropCampaignsInProgress, GameEventDrop } from '../types/twitch/Inventory'

export class Inventory {
	isFetch?: boolean
	dropsClaimed: GameEventDrop[] = []
	dropsProgress: DropCampaignsInProgress[] = []

	reset(): void {
		delete this.isFetch
		this.dropsClaimed = []
		this.dropsProgress = []
	}

	async fetch() {
		const inventory = (await container.twitch.inventory()).at(0)
		this.dropsClaimed = inventory.data.currentUser.inventory.gameEventDrops
		this.dropsProgress = inventory.data.currentUser.inventory.dropCampaignsInProgress
		this.isFetch = true
	}
}
