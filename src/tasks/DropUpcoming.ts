import { Task } from '@vegapunk/core';
import { chalk } from '@vegapunk/utilities';
import { random } from '@vegapunk/utilities/common';
import { sleep, waitUntil } from '@vegapunk/utilities/sleep';
import { dayjs } from '@vegapunk/utilities/time';

import { Tasks } from '../lib/constants/Enum';
import { DropMainTask } from './DropMain';

export class DropUpcomingTask extends Task {
  public constructor(context: Task.LoaderContext) {
    super(context, { name: Tasks.DropUpcoming, delay: 120_000 });

    this.nextRefresh = Date.now() + this.sleepTime;
  }

  public async update(): Promise<void> {
    const mainTask = this.store.get(Tasks.DropMain) as DropMainTask;
    const mainQueue = mainTask.queue;
    const mainCampaign = mainTask.campaign;

    const isMainCall = mainQueue.state === 1 && mainQueue.isSleeping;
    if (isMainCall || this.nextRefresh < Date.now()) {
      await mainCampaign.getCampaigns();
      this.nextRefresh = Date.now() + this.sleepTime;
    }

    const upcomingLength = mainCampaign.upcoming.length;
    if (upcomingLength === 0) {
      if (!mainTask.isStatus.enabled && isMainCall) {
        const waitUntilTime = dayjs(Date.now() + this.sleepTime).format('lll');
        this.container.logger.info(chalk`{bold.yellow No upcoming campaigns.}`);
        this.container.logger.info(chalk`{bold.yellow Sleeping until ${waitUntilTime}.}`);

        mainTask.setDelay(this.sleepTime);
        mainTask.startTask();
      }
      return;
    }

    const nextCampaign = mainCampaign.sortedUpcoming[0];
    const timeToStart = +nextCampaign.startAt - Date.now();
    if (timeToStart <= 0) {
      if (this.isMainCallSleep) {
        this.isMainCallSleep = false;
        mainTask.startTask(true);
        return;
      }
      if (isMainCall) {
        mainTask.queue.state = 3;
        mainTask.queue.isSleeping = false;
      }

      this.container.logger.info(chalk`{bold.yellow ${nextCampaign.name}} | {bold.yellow {strikethrough Upcoming}}.`);

      mainTask.stopTask();
      await waitUntil(() => !mainTask.isStatus.running);

      const currentQueued = mainQueue.peek();
      if (!currentQueued) {
        nextCampaign.priority = 0;
        mainQueue.enqueue(nextCampaign);
        return;
      }

      const currentDrop = currentQueued.drops.peek();
      const isDifferentGame = currentQueued.game.id !== nextCampaign.game.id;
      const shouldPrioritize = currentDrop && isDifferentGame && currentDrop.endAt >= nextCampaign.endAt;

      nextCampaign.priority = shouldPrioritize ? currentQueued.priority + 1 : 0;
      mainQueue.enqueue(nextCampaign);

      await sleep(random(0, 5_000));
      mainTask.startTask(true);
    } else if (!this.isMainCallSleep && isMainCall) {
      this.isMainCallSleep = true;
      const startTime = dayjs(nextCampaign.startAt).format('lll');
      const countStr = chalk`{bold.yellow ${upcomingLength} upcoming}`;

      this.container.logger.info(chalk`{bold.yellow No active campaigns} | ${countStr}.`);
      this.container.logger.info(chalk`{bold.yellow Sleeping until ${startTime}.}`);
    }
  }

  private nextRefresh: number;
  private isMainCallSleep?: boolean;
  private readonly sleepTime: number = 7_200_000;
}
