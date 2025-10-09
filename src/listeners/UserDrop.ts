import { Listener } from '@vegapunk/core';
import { chalk } from '@vegapunk/utilities';
import { uniqueId } from '@vegapunk/utilities/common';

import { Tasks, WsEvents } from '../lib/constants/Enum';
import { Campaign } from '../lib/struct/Campaign';
import { Drop } from '../lib/struct/Drop';
import { writeDebugFile } from '../lib/utils/dev.util';

import type { ResponseContent } from '../lib/api/types/WebSocket';
import type { DropMainTask } from '../tasks/DropMain';

export class UserDropListener extends Listener<WsEvents.UserDrop> {
  public constructor(context: Listener.LoaderContext) {
    super(context, { event: WsEvents.UserDrop });
  }

  public async run(message: ResponseContent): Promise<void> {
    const taskStores = this.container.stores.get('tasks');
    const { queue } = taskStores.get(Tasks.DropMain) as DropMainTask;

    const selectDrop = queue.peek()?.drops.peek();
    if (!selectDrop) {
      return;
    }

    await writeDebugFile(message, `UserDrop-${message.type ? message.type : uniqueId()}`);
    switch (message.type) {
      case 'drop-claim':
        return this.dropClaim(message as DropClaim, selectDrop);
      case 'drop-progress':
        return this.dropProgress(message as DropProgress, selectDrop);
    }
  }

  private async dropClaim(message: DropClaim, selectDrop: Drop): Promise<void> {
    if (message.data.drop_id !== selectDrop.id) {
      return;
    }

    selectDrop['dropInstanceID'] = message.data.drop_instance_id;
  }

  private async dropProgress(message: DropProgress, selectDrop: Drop): Promise<void> {
    if (message.data.drop_id !== selectDrop.id) {
      return;
    }

    const localMinutesWatched = selectDrop.currentMinutesWatched;
    const currentMinutesWatched = message.data.current_progress_min;
    if (localMinutesWatched === currentMinutesWatched) {
      return;
    }

    const desync = currentMinutesWatched - localMinutesWatched;
    Campaign.trackMinutesWatched = 1;
    selectDrop.currentMinutesWatched += desync;

    const str = chalk`{yellow Desync ${Math.max(0, desync) ? '+' : ''}${desync} minutes}`;
    this.container.logger.info(chalk`{green ${selectDrop.name}} | ${str}.`);
  }
}

type DropClaim = ResponseContent<
  'drop-claim',
  {
    readonly drop_id: string;
    readonly channel_id: string;
    readonly drop_instance_id: string;
  }
>;

type DropProgress = ResponseContent<
  'drop-progress',
  {
    readonly drop_id: string;
    readonly channel_id: string;
    readonly current_progress_min: number;
    readonly required_progress_min: number;
  }
>;
