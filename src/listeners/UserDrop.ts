import chalk from 'chalk'
import { Tasks } from '../lib/types/Enum'
import { DropMainTask } from '../tasks/DropMain'
import { DropStore } from '../lib/stores/DropStore'
import { Listener } from '../lib/structures/Listener'
import { DropProgress, MessageData } from '../lib/types/twitch/WebSocket'

export class UserDropListener extends Listener {
	public constructor(context: Listener.Context) {
		super(context, { event: 'user-drop-events' })
	}

	public async run(message: MessageData): Promise<void> {
		const main = this.container.stores.get('tasks').get(Tasks.DropMain) as DropMainTask
		const selectCampaign = main.queue.peek()
		if (!selectCampaign) return

		const selectDrop = selectCampaign.drops
		if (!selectDrop.peek()) return

		switch (message.type) {
			case 'drop-claim':
				this.dropClaim()
				break
			case 'drop-progress':
				this.dropProgress(message as DropProgress, selectDrop)
				break
		}
	}

	private async dropClaim() {}

	private async dropProgress(message: DropProgress, selectDrop: DropStore) {
		const checkDesync = (currentMinutesWatched: number) => {
			if (selectDrop.currentMinutesWatched === currentMinutesWatched) return

			const desync = currentMinutesWatched - selectDrop.currentMinutesWatched
			selectDrop.setMinutesWatched(desync)
			this.container.logger.info(chalk`{bold.yellow ${selectDrop.name}} | Desync ${Math.max(0, desync) ? '+' : ''}${desync} minutes`)
		}

		if (selectDrop.id === message.data.drop_id) {
			this.container.logger.debug(message, 'user-drop-events-1')
			checkDesync(message.data.current_progress_min)
		} else {
			const dropCurrent = (await this.container.twitch.dropCurrent())[0].data.currentUser.dropCurrentSession
			this.container.logger.debug(dropCurrent, 'user-drop-events-2')
			if (!dropCurrent || selectDrop.id !== dropCurrent.dropID) return

			checkDesync(dropCurrent.currentMinutesWatched)
		}
	}
}
