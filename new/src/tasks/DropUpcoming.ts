import { Task } from '@vegapunk/core'
import { chalk } from '@vegapunk/utilities'
import { random } from '@vegapunk/utilities/common'
import { sleep, sleepUntil } from '@vegapunk/utilities/sleep'
import { dayjs } from '@vegapunk/utilities/time'
import { Tasks } from '../lib/constants/Enum'
import { DropMainTask } from './DropMain'

export class DropUpcomingTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { name: Tasks.DropUpcoming, delay: 60_000 * 2, ref: true })

		this.nextRefresh = Date.now() + this.sleepTime
	}

	public async update(): Promise<void> {
		const mainTask = this.store.get(Tasks.DropMain) as DropMainTask
		const { campaign, queue } = mainTask
		const isMainCall = queue.state === 1 && queue.isSleeping

		if (isMainCall || this.nextRefresh < Date.now()) {
			await campaign.getCampaigns()
			this.nextRefresh = Date.now() + this.sleepTime
		}

		const upcomingLength = campaign.upcoming.length
		if (!upcomingLength) {
			if (isMainCall) {
				const sleepUntil = dayjs(Date.now() + this.sleepTime).format('lll')
				this.container.logger.info(chalk`{bold.yellow No upcoming campaigns, Finally i can rest}`)
				this.container.logger.info(chalk`{bold.yellow Sleeping until ${sleepUntil}}`)

				mainTask.setDelay(this.sleepTime)
				mainTask.startTask()
			}
			return
		}

		const selectCampaign = campaign.sortedUpcoming[0]
		const [currentDate, upcomingDate] = [new Date(), selectCampaign.startAt]

		const sleepTime = Math.max(0, +upcomingDate - +currentDate)
		if (!sleepTime) {
			if (this.isMainCallSleep) {
				this.isMainCallSleep = false
				return mainTask.startTask(true)
			}
			if (isMainCall) {
				queue.state = 3
				queue.isSleeping = false
			}

			this.container.logger.info(chalk`{bold.yellow ${selectCampaign.name}} | {bold.yellow {strikethrough Upcoming}}`)

			mainTask.stopTask()
			await sleepUntil(() => !mainTask.isStatus.running)

			const mainDrop = queue.peek()?.drops.peek()
			const isGame = queue.peek()?.game.id === selectCampaign.game.id
			const isPriority = mainDrop && !isGame && mainDrop.endAt >= selectCampaign.endAt
			queue.enqueue(selectCampaign, isPriority ? queue.highest + 1 : 0)

			await sleep(random(0, 5_000))
			return mainTask.startTask(true)
		}

		if (isMainCall) {
			this.isMainCallSleep = true
			const sleep = dayjs(upcomingDate).format('lll')
			const str = chalk`{bold.yellow ${upcomingLength} upcoming}`
			this.container.logger.info(chalk`{bold.yellow No active campaigns/drops} | ${str}`)
			this.container.logger.info(chalk`{bold.yellow Sleeping until ${sleep}}`)
		}
	}

	private nextRefresh: number
	private isMainCallSleep?: boolean

	private readonly sleepTime = 60_000 * 60 * 2 // 2 hours
}
