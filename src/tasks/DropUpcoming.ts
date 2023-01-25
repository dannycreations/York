import chalk from 'chalk'
import delay from 'delay'
import { remove, sortBy } from 'lodash'
import { DropMainTask } from './DropMain'
import { Tasks } from '../lib/types/Enum'
import { Task } from '../lib/structures/Task'
import { getTimezoneDate } from '../lib/utils/util'
import { DropCampaign } from '../lib/types/twitch/ViewerDropsDashboard'

export class DropUpcomingTask extends Task {
	private isSleeping?: boolean

	public constructor(context: Task.Context) {
		super(context, { name: Tasks.DropUpcoming, delay: 6e5 })
	}

	public async run(): Promise<void> {
		super.setDelay(this.options.delay)

		const main = this.container.stores.get('tasks').get(Tasks.DropMain) as DropMainTask
		const isSleeping = main.queue.isSleeping() && !super.isStatus().running
		if (!main.campaign.upcomingList().length) {
			if (isSleeping) {
				const sleepTime = 3.6e6
				const sleepUntil = getTimezoneDate(new Date(Date.now() + sleepTime)).format('lll')
				this.container.logger.info(chalk`{bold.yellow No upcoming campaigns, Finally I can sleep well}`)
				this.container.logger.info(chalk`{bold.yellow Sleeping until ${sleepUntil}}`)

				main.setDelay(sleepTime)
				main.startTask()
			}
			return
		}

		const upcomingList = sortBy(main.campaign.upcomingList(), 'startAt')
		const selectCampaign = upcomingList[0]

		const currentDate = new Date()
		const upcomingDate = new Date(selectCampaign.startAt)
		const sleepTime = Math.max(0, +upcomingDate - +currentDate)
		if (!sleepTime) {
			remove(main.campaign.upcomingList(), { id: selectCampaign.id })
			if (this.isSleeping) {
				delete this.isSleeping
				return main.startTask(true)
			}
			if (isSleeping) {
				main.queue.isState(3)
				main.queue.isSleeping(false)
			}

			this.container.logger.info(chalk`{bold.yellow ${selectCampaign.name}} | {strikethrough Upcoming}`)

			main.stopTask()
			await super.sleepUntil(() => !main.isStatus().running)

			const mainDrop = main.queue.peek()?.drops.peek()
			const isGame = main.queue.peek()?.game.displayName === selectCampaign.game.displayName
			if (mainDrop && mainDrop.endAt > selectCampaign.endAt && (!isGame || mainDrop.startAt > selectCampaign.startAt)) {
				main.queue.clear()
				main.queue.isTask(false)
				main.campaign.gameList([selectCampaign.game.displayName, ...main.campaign.gameList()])
				main.campaign.campaignList([selectCampaign as DropCampaign, ...main.campaign.campaignList()])
			} else {
				main.campaign.gameList().push(selectCampaign.game.displayName)
				main.campaign.campaignList().push(selectCampaign as DropCampaign)
			}

			main.campaign.resetInventory()
			await delay.range(0, 5000)
			return main.startTask(true)
		}

		super.setDelay(sleepTime)

		if (isSleeping) {
			this.isSleeping = true
			const sleepUntil = getTimezoneDate(upcomingDate).format('lll')
			this.container.logger.info(chalk`{bold.yellow No active campaigns/drops} | ${upcomingList.length} upcoming`)
			this.container.logger.info(chalk`{bold.yellow Sleeping until ${sleepUntil}}`)
		}
	}
}
