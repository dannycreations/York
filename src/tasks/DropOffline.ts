import { Task } from '@vegapunk/core'
import { sleep, sleepUntil } from '@vegapunk/utilities'
import chalk from 'chalk'
import { random, remove, sortBy } from 'lodash'
import { Tasks } from '../lib/api/constants/Enum'
import { DropCampaign } from '../lib/api/types/ViewerDropsDashboard'
import { DropMainTask } from './DropMain'

export class DropOfflineTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { name: Tasks.DropOffline, delay: 60_000 * 5 })
	}

	public async run(): Promise<void> {
		const taskStores = this.container.stores.get('tasks')
		const mainTask = taskStores.get(Tasks.DropMain) as DropMainTask
		if (!mainTask.campaign.offline().length) return

		const priorityList = this.container.client.config.priorityList
		const offlineList = sortBy(mainTask.campaign.offline(), (r) => !~priorityList.indexOf(r.game))
		for (const offline of offlineList) {
			const activeCampaign = await mainTask.campaign.checkCampaign({ dropID: offline.id })
			const selectDrop = activeCampaign.drops.peek()
			if (!selectDrop || !activeCampaign.drops.isStatus().active) {
				remove(mainTask.campaign.offline(), { id: offline.id })
				continue
			}
			if (!(await activeCampaign.channels.watch())) continue

			remove(mainTask.campaign.offline(), { id: offline.id })
			this.container.logger.info(chalk`{bold.yellow ${activeCampaign.name}} | {strikethrough Offline}`)

			mainTask.stopTask()
			await sleepUntil(() => !mainTask.isStatus.running)

			const mainDrop = mainTask.queue.peek()?.drops.peek()
			const isGame = mainTask.queue.peek()?.game.displayName === activeCampaign.game.displayName
			if (mainDrop && mainDrop.endAt > selectDrop.endAt && (!isGame || mainDrop.startAt > selectDrop.startAt)) {
				mainTask.queue.clear()
				mainTask.queue.hasTask(false)
				mainTask.campaign.games([activeCampaign.game.displayName, ...mainTask.campaign.games()])
				mainTask.campaign.campaign([activeCampaign as unknown as DropCampaign, ...mainTask.campaign.campaign()])
			} else {
				mainTask.campaign.games().push(activeCampaign.game.displayName)
				mainTask.campaign.campaign().push(activeCampaign as unknown as DropCampaign)
			}

			mainTask.campaign.resetInventory()
			await sleep(random(0, 5_000))
			return mainTask.startTask(true)
		}
	}
}
