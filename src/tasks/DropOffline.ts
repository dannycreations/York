import { Task } from '@vegapunk/core';
import { chalk } from '@vegapunk/utilities';
import { random, sortBy } from '@vegapunk/utilities/common';
import { sleep, waitForEach, waitUntil } from '@vegapunk/utilities/sleep';

import { Tasks } from '../lib/constants/Enum';
import { DropMainTask } from './DropMain';

export class DropOfflineTask extends Task {
  public constructor(context: Task.LoaderContext) {
    super(context, { name: Tasks.DropOffline, delay: 120_000 });
  }

  public async update(): Promise<void> {
    const mainTask = this.store.get(Tasks.DropMain) as DropMainTask;
    const mainQueue = mainTask.queue;
    const mainCampaign = mainTask.campaign;
    const { priorityList } = this.container.client.config;

    const sortedOffline = sortBy(mainCampaign.sortedOffline, [(r) => !priorityList.includes(r.game.displayName)]);
    await waitForEach(sortedOffline, async (offCampaign) => {
      if (offCampaign.isStatus.expired) {
        mainCampaign.delete(offCampaign.id);
        return false;
      }
      if (offCampaign.drops.size === 0) {
        await mainCampaign.getProgress();
        await offCampaign.getDrops();
      }
      if (!offCampaign.drops.peek()) {
        return false;
      }

      await offCampaign.getChannels();
      if (!offCampaign.channels.peek()) {
        return false;
      }

      offCampaign.isOffline = false;
      this.container.logger.info(chalk`{bold.yellow ${offCampaign.name}} | {bold.yellow {strikethrough Offline}}.`);

      mainTask.stopTask();
      await waitUntil(() => !mainTask.isStatus.running);

      const currentQueued = mainQueue.peek();
      if (!currentQueued) {
        offCampaign.priority = 0;
        mainQueue.enqueue(offCampaign);
        return;
      }

      const currentDrop = currentQueued.drops.peek();
      const isDifferentGame = currentQueued.game.id !== offCampaign.game.id;
      const shouldPrioritize = currentDrop && isDifferentGame && currentDrop.endAt >= offCampaign.endAt;

      offCampaign.priority = shouldPrioritize ? currentQueued.priority + 1 : 0;
      mainQueue.enqueue(offCampaign);

      await sleep(random(0, 5_000));
      mainTask.startTask(true);
      return true;
    });
  }
}
