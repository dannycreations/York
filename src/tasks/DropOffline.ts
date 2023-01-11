import chalk from 'chalk'
import { remove } from 'lodash'
import { DropMainTask } from './DropMain'
import { Tasks } from '../lib/types/Enum'
import { Task } from '../lib/structures/Task'

export class DropOfflineTask extends Task {
	public constructor(context: Task.Context) {
		super(context, { name: Tasks.DropOffline, delay: 6e5 })
	}

	public async run(): Promise<void> {
		const main = this.container.stores.get('tasks').get(Tasks.DropMain) as DropMainTask
		if (!main.campaign.offlineList().length) return

		const hasPriority = main.campaign.offlineList().filter((r) => !!~this.container.config.priorityList.indexOf(r.game))
		const offlineList = hasPriority.length ? hasPriority : main.campaign.offlineList()
		for (const offline of offlineList) {
			const activeCampaign = await main.campaign.checkCampaign({ dropID: offline.id })
			if (!activeCampaign.drops.isStatus()?.active) {
				remove(main.campaign.offlineList(), { id: offline.id })
				continue
			}
			if (!(await activeCampaign.channels.watch())) continue

			main.stopTask()
			await main.sleepUntil(() => !main.isStatus().running())

			const selectDrop = main.queue.peek()?.drops.peek()
			if (selectDrop && selectDrop.endAt > activeCampaign.drops.peek()!.endAt) {
				const tempActiveCampaign = [activeCampaign, ...main.queue.values()]
				main.queue.clear()
				main.queue.enqueueMany(tempActiveCampaign)
			} else {
				main.queue.enqueue(activeCampaign)
			}
			remove(main.campaign.offlineList(), { id: offline.id })

			main.setDelay(main.options.delay)
			main.startTask()

			this.container.logger.info(chalk`{green ${activeCampaign.name}} | {yellow Waking from sleep}`)
			this.container.logger.info(chalk`{green ${activeCampaign.name}} | Found ${activeCampaign.drops.length} drops`)
			break
		}
	}
}
