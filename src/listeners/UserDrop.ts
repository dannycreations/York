import chalk from 'chalk'
import { Tasks } from '../lib/types/Enum'
import { DropMainTask } from '../tasks/DropMain'
import { DropStore } from '../lib/stores/DropStore'
import { Listener } from '../lib/structures/Listener'
import { UserDropEvents } from '../lib/types/twitch/WebSocket'

export class UserDropListener extends Listener {
	public constructor(context: Listener.Context) {
		super(context, { event: 'user-drop-events' })
	}

	public async run(message: UserDropEvents): Promise<void> {
		const main = this.container.stores.get('tasks').get(Tasks.DropMain) as DropMainTask
		const selectCampaign = main.queue.peek()
		if (!selectCampaign) return

		const selectDrop = selectCampaign.drops
		if (!selectDrop.peek()) return

		if (selectDrop.id === message.data.drop_id) {
			this.checkDesync(selectDrop, message.data.current_progress_min)
		} else {
			const dropCurrent = (await this.container.twitch.dropCurrent())[0].data.currentUser.dropCurrentSession
			if (!dropCurrent || selectDrop.id !== dropCurrent.dropID) return

			this.checkDesync(selectDrop, dropCurrent.currentMinutesWatched)
		}
	}

	private checkDesync(selectDrop: DropStore, currentMinutesWatched: number): void {
		if (typeof currentMinutesWatched !== 'number') return
		if (typeof selectDrop.currentMinutesWatched !== 'number') return
		if (selectDrop.currentMinutesWatched === currentMinutesWatched) return

		const desync = currentMinutesWatched - selectDrop.currentMinutesWatched
		selectDrop.setMinutesWatched(desync)
		this.container.logger.info(chalk`{green ${selectDrop.name}} | Desync ${!!~desync ? '+' : ''}${desync} minutes`)
	}
}
