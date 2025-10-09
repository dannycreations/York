import { Listener } from '@vegapunk/core';
import { uniqueId } from '@vegapunk/utilities/common';

import { Tasks, WsEvents } from '../lib/constants/Enum';
import { Channel } from '../lib/struct/Channel';
import { writeDebugFile } from '../lib/utils/dev.util';

import type { ResponseContent } from '../lib/api/types/WebSocket';
import type { DropMainTask } from '../tasks/DropMain';

export class ChannelUpdateListener extends Listener<WsEvents.ChannelUpdate> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: WsEvents.ChannelUpdate });
  }

  public async run(message: ResponseContent): Promise<void> {
    const taskStores = this.container.stores.get('tasks');
    const { queue } = taskStores.get(Tasks.DropMain) as DropMainTask;

    const selectChannel = queue.peek()?.channels.peek();
    if (!selectChannel) {
      return;
    }

    await writeDebugFile(message, `ChannelUpdate-${message.type ? message.type : uniqueId()}`);
    switch (message.type) {
      case 'broadcast_settings_update':
        return this.channelUpdate(message as unknown as ChannelUpdate, selectChannel);
    }
  }

  private channelUpdate(message: ChannelUpdate, selectChannel: Channel): void {
    if (message.channel_id !== selectChannel.id || typeof selectChannel.gameId !== 'string') {
      return;
    }

    const currentGameId = String(message.game_id);
    if (selectChannel.gameId !== currentGameId) {
      selectChannel.isOnline = false;
    }

    selectChannel.currentGameId = currentGameId;
  }
}

interface ChannelUpdate {
  readonly topic_id: string;
  readonly type: 'broadcast_settings_update';
  readonly channel: string;
  readonly channel_id: string;
  readonly status: string;
  readonly old_status: string;
  readonly game: string;
  readonly old_game: string;
  readonly game_id: number;
  readonly old_game_id: number;
}
