import { Listener } from '@vegapunk/core'
import { uniqueId } from '@vegapunk/utilities/common'
import { MessageData } from '../lib/api/types/WebSocket'
import { Tasks, WsEvents } from '../lib/constants/Enum'
import { Channel } from '../lib/struct/Channel'
import { writeDebugFile } from '../lib/utils/dev.util'
import { DropMainTask } from '../tasks/DropMain'

export class UserListener extends Listener<WsEvents.ChannelMoment> {
	public constructor(context: Listener.LoaderContext) {
		super(context, { event: WsEvents.ChannelMoment })
	}

	public async run(message: MessageData): Promise<void> {
		const taskStores = this.container.stores.get('tasks')
		const { queue } = taskStores.get(Tasks.DropMain) as DropMainTask

		const selectChannel = queue.peek()?.channels.peek()
		if (!selectChannel) return

		await writeDebugFile(message, `ChannelMoment-${message.type ? message.type : uniqueId()}`)
		if (message.topic_id === selectChannel.id && message.type !== 'active') return

		await this.momentClaim(message as MomentClaim, selectChannel)
	}

	private async momentClaim(message: MomentClaim, selectChannel: Channel) {
		await selectChannel.claimMoments(message.data.moment_id)
	}
}

type MomentClaim = MessageData<'active', { moment_id: string }>
