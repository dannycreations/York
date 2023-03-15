import chalk from 'chalk'
import delay from 'delay'
import { remove } from 'lodash'
import { DropMainTask } from './DropMain'
import { Tasks } from '../lib/types/Enum'
import { Task } from '../lib/structures/Task'
import { DropCampaign } from '../lib/types/twitch/ViewerDropsDashboard'

export class DropOfflineTask extends Task {
	public constructor(context: Task.Context) {
		super(context, { name: Tasks.DropOffline, delay: 600_000 })
	}

	public async run(): Promise<void> {
		const main = this.container.stores.get('tasks').get(Tasks.DropMain) as DropMainTask
		if (!main.campaign.offlineList().length) return

		const hasPriority = main.campaign.offlineList().filter((r) => !!~this.container.config.priorityList.indexOf(r.game))
		const offlineList = hasPriority.length ? hasPriority : main.campaign.offlineList()
		for (const offline of offlineList) {
			const activeCampaign = await main.campaign.checkCampaign({ dropID: offline.id })
			const selectDrop = activeCampaign.drops.peek()
			if (!selectDrop || !activeCampaign.drops.isStatus().active) {
				remove(main.campaign.offlineList(), { id: offline.id })
				continue
			}
			if (!(await activeCampaign.channels.watch())) continue

			remove(main.campaign.offlineList(), { id: offline.id })
			this.container.logger.info(chalk`{bold.yellow ${activeCampaign.name}} | {strikethrough Offline}`)

			main.stopTask()
			await super.sleepUntil(() => !main.isStatus().running)

			const mainDrop = main.queue.peek()?.drops.peek()
			const isGame = main.queue.peek()?.game.displayName === activeCampaign.game.displayName
			if (mainDrop && mainDrop.endAt > selectDrop.endAt && (!isGame || mainDrop.startAt > selectDrop.startAt)) {
				main.queue.clear()
				main.queue.isTask(false)
				main.campaign.gameList([activeCampaign.game.displayName, ...main.campaign.gameList()])
				main.campaign.campaignList([activeCampaign as unknown as DropCampaign, ...main.campaign.campaignList()])
			} else {
				main.campaign.gameList().push(activeCampaign.game.displayName)
				main.campaign.campaignList().push(activeCampaign as unknown as DropCampaign)
			}

			main.campaign.resetInventory()
			await delay.range(0, 5_000)
			return main.startTask(true)
		}
	}
}
