import { Campaign } from '../lib/resolvers/Campaign'
import { Task } from '../lib/structures/Task'

export class DropMainTask extends Task {
	public campaign = new Campaign()

	public constructor(context: Task.Context) {
		super(context, { delay: 60_000 })
	}

	public async runOnInit() {
		await this.run()
		await this.campaign.fetch()

		const tes = await this.container.campaignRepository.find({})
		console.log(tes)
	}

	public async run() {
		console.log('tesss')
	}
}
