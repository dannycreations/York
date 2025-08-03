import { Listener } from '@vegapunk/core';
import { uniqueId } from '@vegapunk/utilities/common';

import { ResponseContent } from '../lib/api/types/WebSocket';
import { Tasks, WsEvents } from '../lib/constants/Enum';
import { writeDebugFile } from '../lib/utils/dev.util';
import { DropMainTask } from '../tasks/DropMain';

export class UserListener extends Listener<WsEvents.ChannelStream> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: WsEvents.ChannelStream });
  }

  public async run(message: ResponseContent): Promise<void> {
    const taskStores = this.container.stores.get('tasks');
    const { queue } = taskStores.get(Tasks.DropMain) as DropMainTask;

    const selectChannel = queue.peek()?.channels.peek();
    if (!selectChannel) return;

    await writeDebugFile(message, `ChannelStream-${message.type ? message.type : uniqueId()}`);

    if (message.topic_id === selectChannel.id) {
      if (message.type === 'stream-down') {
        selectChannel.isOnline = false;
      }
    } else {
      await selectChannel.unlisten(message.topic_id);
    }
  }
}
