import { Task } from '@vegapunk/core'
import { chalk } from '@vegapunk/utilities'
import { random, sortBy } from '@vegapunk/utilities/common'
import { sleep, sleepForOf, sleepUntil } from '@vegapunk/utilities/sleep'
import { Tasks } from '../lib/constants/Enum'
import { DropMainTask } from './DropMain'

export class DropOfflineTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { name: Tasks.DropOffline, delay: 60_000 * 2, ref: true })
	}

	public async update(): Promise<void> {
		const mainTask = this.store.get(Tasks.DropMain) as DropMainTask
		const { campaign, queue } = mainTask

		const { priorityList } = this.container.client.config
		const sortedOffline = sortBy(campaign.sortedOffline, [(r) => !priorityList.includes(r.game.displayName)])
		await sleepForOf(sortedOffline, async (selectCampaign) => {
			if (selectCampaign.isStatus.expired) {
				campaign.delete(selectCampaign.id)
				return false
			}

			if (!selectCampaign.drops.length) {
				await campaign.getProgress()
				await selectCampaign.getDrops()
			}

			const selectDrop = selectCampaign.drops.peek()
			if (!selectDrop) return false

			await selectCampaign.getChannels()
			const selectChannel = selectCampaign.channels.peek()
			if (!selectChannel) return false

			selectCampaign.isOffline = false
			this.container.logger.info(chalk`{bold.yellow ${selectCampaign.name}} | {bold.yellow {strikethrough Offline}}`)

			mainTask.stopTask()
			await sleepUntil(() => !mainTask.isStatus.running)

			const mainDrop = queue.peek()?.drops.peek()
			const isGame = queue.peek()?.game.id === selectCampaign.game.id
			const isPriority = mainDrop && !isGame && mainDrop.endAt >= selectDrop.endAt
			queue.enqueue(selectCampaign, isPriority ? queue.highest + 1 : 0)

			await sleep(random(0, 5_000))
			mainTask.startTask(true)
			return true
		})
	}
}
