import { Task } from '@vegapunk/core'
import { Campaign } from '../lib/resolvers/Campaign'

export class CampaignTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { delay: 10_000 })
	}

	public override async start() {
		console.log('masokk 1')
		await Campaign.Instance.fetch()
		console.log('masokk 2')
	}

	public async update() {
		console.log('masokk 3')
		const dataCampaigns = await this.container.campaignRepository.find({})
		for (const campaign of dataCampaigns) {
			await Campaign.Instance.checkCampaign({ dropID: campaign.id })
		}
	}
}
