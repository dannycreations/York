import { Task } from '@vegapunk/core'
import { Campaign } from '../lib/resolvers/Campaign'

export class CampaignTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { delay: 60_000 })
	}

	public override async runOnInit() {
		await Campaign.Instance.fetch()
	}

	public async run() {
		const dataCampaigns = await this.container.campaignRepository.find({})
		for (const campaign of dataCampaigns) {
			await Campaign.Instance.checkCampaign({ dropID: campaign.id })
		}
	}
}
