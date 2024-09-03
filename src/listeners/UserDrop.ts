import { Listener } from '@vegapunk/core'
import { chalk } from '@vegapunk/utilities'
import { Tasks } from '../lib/api/constants/Enum'
import { DropClaim, DropProgress, MessageData } from '../lib/api/types/WebSocket'
import { DropStore } from '../lib/stores/DropStore'
import { DropMainTask } from '../tasks/DropMain'

export class UserDropListener extends Listener {
	public constructor(context: Listener.LoaderContext) {
		super(context, { event: 'user-drop-events' })
	}

	public async run(message: MessageData) {
		const taskStores = this.container.stores.get('tasks')
		const mainTask = taskStores.get(Tasks.DropMain) as DropMainTask
		const selectDrop = mainTask.queue.peek()?.drops
		if (!selectDrop?.peek()) return

		switch (message.type) {
			case 'drop-claim':
				return this.dropClaim(message as DropClaim)
			case 'drop-progress':
				return this.dropProgress(message as DropProgress, selectDrop)
			default:
				this.container.logger.warn(message, 'Unknown message at user-drop-events')
		}
	}

	private async dropClaim(message: DropClaim) {
		if (!this.container.client.config.isClaimDrops) return false
		const res = await this.container.twitch.claimDrops(message.data.drop_instance_id)
		return 'claimDropRewards' in res.data
	}

	private async dropProgress(message: DropProgress, selectDrop: DropStore) {
		let currentProgress = 0
		if (selectDrop.id === message.data.drop_id) {
			this.container.logger.debug(message, 'user-drop-events-1')
			currentProgress = message.data.current_progress_min
		} else {
			const dropCurrent = (await this.container.twitch.dropCurrent()).data.currentUser.dropCurrentSession
			this.container.logger.debug(dropCurrent, 'user-drop-events-2')
			if (!dropCurrent || selectDrop.id !== dropCurrent.dropID) return

			currentProgress = dropCurrent.currentMinutesWatched
		}

		if (selectDrop.currentMinutesWatched === currentProgress) return

		const desync = currentProgress - selectDrop.currentMinutesWatched
		selectDrop.setMinutesWatched(desync)
		this.container.logger.info(chalk`{bold.yellow ${selectDrop.name}} | Desync ${Math.max(0, desync) ? '+' : ''}${desync} minutes`)
	}
}
