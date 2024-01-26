import { Task } from '@dnycts/shaka'
import { Campaign } from '../lib/resolvers/Campaign'

export class DropMainTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { delay: 60_000 })
	}

	public async runOnInit() {
		await Campaign.Instance.fetch()

		const tes = (await this.container.campaignRepository.find({})).at(0)
		console.log(tes)
	}

	public async run() {
		console.log('tesss')
		await Campaign.Instance.fetch()
	}
}
