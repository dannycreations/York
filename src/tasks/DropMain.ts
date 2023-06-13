import { Tasks } from '../lib/types/Enum'
import { Task } from '../lib/structures/Task'
import { Campaign } from '../lib/resolvers/Campaign'
import chalk from 'chalk'
import { remove } from 'lodash'

export class DropMainTask extends Task {
	public campaign: Campaign

	public constructor(context: Task.Context) {
		super(context, { name: Tasks.DropMain, delay: 60_000 })
		this.campaign = new Campaign()
	}

	public async runOnInit(): Promise<void> {
		await this.run()

		await this.campaign.fetchCampaign()
		this.campaign.gameList([...new Set(this.container.config.priorityList)])

		console.log(this.campaign.gameList())

		loopGameList: while (this.campaign.gameList().length) {
			let isActiveCampaign = false
			const campaignList = await this.container.campaignRepository.findAll()
			for (const campaign of campaignList) {
				if (this.campaign.gameList()[0] !== campaign.game) continue

				await this.campaign.checkCampaign({ dropID: campaign.id })
				const activeDrops = await this.container.dropRepository.find({ campaign: campaign.id })
				if (!activeDrops.length) {
					isActiveCampaign = true
					this.campaign.gameList()[0] = campaign.name
					await this.container.campaignRepository.nativeDelete({ id: campaign.id })
					break
				}

				// this.queue.isTask(true)
				// this.queue.enqueue(activeCampaign)
				this.container.logger.info(chalk`{green ${campaign.name}} | Found ${activeDrops.length} drops`)
				console.log(JSON.stringify(await this.container.campaignRepository.find({ id: campaign.id })))
				console.log()
				console.log(JSON.stringify(await this.container.channelRepository.findAll()))
				process.exit()
				break loopGameList
			}

			this.container.logger.info(chalk`{red ${this.campaign.gameList()[0]}} | No active ${isActiveCampaign ? 'drops' : 'campaigns'}`)
			this.campaign.gameList().shift()
		}

		// const dropTopic = `user-drop-events.${this.container.twitch.userID}`
		// await this.container.ws.send(RequestType.Listen, dropTopic)
	}

	public async run(): Promise<void> {
		console.log('tesss')
	}
}
