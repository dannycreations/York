import { Task } from '@vegapunk/core'
import { getTimezoneDate } from '@vegapunk/logger'
import { _, chalk, sleep, sleepUntil } from '@vegapunk/utilities'
import { Tasks } from '../lib/api/constants/Enum'
import { DropCampaign } from '../lib/api/types/ViewerDropsDashboard'
import { DropMainTask } from './DropMain'

export class DropUpcomingTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { name: Tasks.DropUpcoming, delay: 60_000 * 5, ref: true })
	}

	public async update() {
		super.setDelay(this.options.delay)

		const mainTask = this.store.get(Tasks.DropMain) as DropMainTask
		const isSleeping = mainTask.queue.isSleeping() && !super.isStatus.running

		if (!mainTask.campaign.upcoming().length) {
			if (isSleeping) {
				const sleepTime = 3_600_000 * 2 // 2 hours
				const sleepUntil = getTimezoneDate(new Date(Date.now() + sleepTime)).format('lll')
				this.container.logger.info(chalk`{bold.yellow No upcoming campaigns, Finally i can rest}`)
				this.container.logger.info(chalk`{bold.yellow Sleeping until ${sleepUntil}}`)

				mainTask.setDelay(sleepTime)
				mainTask.startTask()
			}
			return
		}

		const upcomingList = _.sortBy(mainTask.campaign.upcoming(), 'startAt')
		const selectCampaign = upcomingList[0]

		const currentDate = new Date()
		const upcomingDate = new Date(selectCampaign.startAt)
		const sleepTime = Math.max(0, +upcomingDate - +currentDate)
		if (!sleepTime) {
			_.remove(mainTask.campaign.upcoming(), { id: selectCampaign.id })
			if (this.container.client.config.isDropPriorityOnly) {
				if (!~this.container.client.config.priorityList.indexOf(selectCampaign.game.displayName)) {
					return
				}
			}
			if (this.isSleeping) {
				this.isSleeping = undefined
				return mainTask.startTask(true)
			}
			if (isSleeping) {
				mainTask.queue.isState(3)
				mainTask.queue.isSleeping(false)
			}

			this.container.logger.info(chalk`{bold.yellow ${selectCampaign.name}} | {strikethrough Upcoming}`)

			mainTask.stopTask()
			await sleepUntil(() => !mainTask.isStatus.running)

			const mainDrop = mainTask.queue.peek()?.drops.peek()
			const isGame = mainTask.queue.peek()?.game.displayName === selectCampaign.game.displayName
			if (mainDrop && mainDrop.endAt > selectCampaign.endAt && (!isGame || mainDrop.startAt > selectCampaign.startAt)) {
				mainTask.queue.clear()
				mainTask.queue.hasTask(false)
				mainTask.campaign.games([selectCampaign.game.displayName, ...mainTask.campaign.games()])
				mainTask.campaign.campaign([selectCampaign as DropCampaign, ...mainTask.campaign.campaign()])
			} else {
				mainTask.campaign.games().push(selectCampaign.game.displayName)
				mainTask.campaign.campaign().push(selectCampaign as DropCampaign)
			}

			mainTask.campaign.resetInventory()
			await sleep(_.random(0, 5_000))
			return mainTask.startTask(true)
		}

		super.setDelay(sleepTime)

		if (isSleeping) {
			this.isSleeping = true
			const sleepUntil = getTimezoneDate(upcomingDate).format('lll')
			this.container.logger.info(chalk`{bold.yellow No active campaigns/drops} | ${upcomingList.length} upcoming`)
			this.container.logger.info(chalk`{bold.yellow Sleeping until ${sleepUntil}}`)
		}
	}

	private isSleeping?: boolean
}
