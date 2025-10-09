import { Task } from '@vegapunk/core';
import { chalk, descend } from '@vegapunk/utilities';
import { Result } from '@vegapunk/utilities/result';
import { sleep, waitForIter } from '@vegapunk/utilities/sleep';

import { Tasks, WsEvents } from '../lib/constants/Enum';
import { CampaignStore } from '../lib/stores/CampaignStore';
import { QueueStore } from '../lib/stores/QueueStore';
import { Campaign } from '../lib/struct/Campaign';

const MAIN_TOPICS = [WsEvents.UserDrop, WsEvents.UserPoint] as const;

export class DropMainTask extends Task {
  public readonly campaign: CampaignStore = new CampaignStore();
  public readonly queue: QueueStore<Campaign> = new QueueStore((a, b) => descend(a.priority, b.priority));

  public constructor(context: Task.LoaderContext) {
    super(context, { name: Tasks.DropMain, delay: 10_000 });
  }

  public override async awake(): Promise<void> {
    let lastCheckedDay: number | undefined = undefined;
    await Task.createTask({
      update: () => {
        const currentDay = new Date().getDate();
        if (lastCheckedDay === undefined) {
          lastCheckedDay = currentDay;
          return;
        }
        if (currentDay === lastCheckedDay) {
          return;
        }

        lastCheckedDay = currentDay;
        this.container.logger.info(chalk`{bold.yellow It's midnight time. Restarting app...}`);
        this.container.client.destroy();
      },
      options: { name: 'midnight', delay: 10_000 },
    });
  }

  public override async start(): Promise<void> {
    await Promise.all(
      MAIN_TOPICS.map((topic) => {
        const userId = this.container.api.userId!;
        return this.container.ws.listen([topic, userId]);
      }),
    );
    await this.update();
  }

  public async update(): Promise<void> {
    super.setDelay(this.options.delay);

    await this.create();
    const selectCampaign = this.queue.peek();
    if (!selectCampaign) {
      return;
    }
    if (selectCampaign.channels.last) {
      await selectCampaign.channels.last.unlisten();
      selectCampaign.channels['lastHeap'] = undefined;
    }
    if (selectCampaign.status.expired) {
      this.container.logger.info(chalk`${selectCampaign.name} | {red Campaigns expired}.`);
      this.campaign.delete(selectCampaign.id);
      this.queue.dequeue();
      return this.update();
    }
    if (!this.queue.isWorking) {
      await selectCampaign.getDrops();
    }

    const selectDrop = selectCampaign.drops.peek();
    if (!selectDrop) {
      this.container.logger.info(chalk`${selectCampaign.name} | {red No active drops}.`);
      this.queue.dequeue();
      return this.update();
    }
    if (!selectDrop.hasPreconditionsMet) {
      this.container.logger.info(chalk`{green ${selectDrop.name}} | {red Preconditions drops}.`);
      this.queue.dequeue();
      return this.update();
    }
    if (selectDrop.isMinutesWatchedMet) {
      if (!this.container.client.config.isClaimDrops) {
        selectCampaign.drops.dequeue();
      } else {
        const total = 5;
        await waitForIter(total, async (i) => {
          const run = await Result.fromAsync(async () => {
            if (!selectDrop.hasAward) {
              await this.campaign.getProgress();
              await selectCampaign.getDrops();
            }
            return selectCampaign.claimDrops();
          });
          return run.match({
            ok: (status) => {
              if (status) {
                selectCampaign.drops.dequeue();
                const currentDrop = selectCampaign.drops.peek();
                if (currentDrop) {
                  currentDrop.hasPreconditionsMet = true;
                }

                this.queue.isWorking = true;
                return true;
              }
              if (!selectDrop.isMinutesWatchedMet) {
                if (selectDrop.requiredMinutesWatched - selectDrop.currentMinutesWatched >= 20) {
                  this.container.logger.info(chalk`{green ${selectDrop.name}} | {red Possible broken drops}.`);
                  this.queue.dequeue();
                } else {
                  selectCampaign.channels.dequeue();
                }
                return true;
              }

              if (!i) {
                this.container.logger.info(chalk`{green ${selectDrop.name}} | {red Award not found}.`);
              }
              this.container.logger.info(chalk`{yellow Waiting for ${i + 1}/${total} minutes}.`);
              if (i + 1 === total) {
                selectCampaign.drops.dequeue();
              }
              return sleep(60_000, false);
            },
            err: (error: unknown) => {
              this.container.logger.info(error, chalk`{green ${selectDrop.name}} | {red Possible service error}.`);
              selectCampaign.drops.dequeue();
              return true;
            },
          });
        });
      }
      return this.update();
    }
    if (!this.queue.isWorking) {
      await selectCampaign.getChannels();
    }

    const selectChannel = selectCampaign.channels.peek();
    if (!selectChannel) {
      selectCampaign.isOffline = true;
      this.container.logger.info(chalk`${selectCampaign.name} | {red Campaigns offline}.`);
      this.queue.dequeue();
      return this.update();
    }
    if (!this.queue.isWorking) {
      const drops = `${selectCampaign.drops.size} drops`;
      const channels = `${selectCampaign.channels.size} channels`;
      this.container.logger.info(chalk`${selectCampaign.name} | {yellow Found ${drops} / ${channels}}.`);
    }

    this.queue.isWorking = true;
    await Promise.all([selectCampaign.watch(), selectChannel.claimMoments(), selectChannel.claimPoints()]);
    if (!selectChannel.isOnline) {
      return this.update();
    }
  }

  private async create(): Promise<void> {
    if (this.queue.isSleeping || this.queue.size > 0) {
      return;
    }
    if (this.queue.state === 3) {
      super.stopTask();
      this.queue.clear();
      this.queue.state = 1;
      this.queue.isSleeping = true;

      const taskStores = this.container.stores.get('tasks');
      const upcomingTask = taskStores.get(Tasks.DropUpcoming)!;
      await upcomingTask.update();
      return this.container.logger.info('');
    }

    const { priorityList } = this.container.client.config;
    await Promise.all([this.campaign.getProgress(), this.campaign.getCampaigns()]);

    const campaigns = this.campaign.sortedActive;
    const priorities = campaigns.filter((campaign) => priorityList.has(campaign.game.displayName));
    const hasPriority = this.queue.state === 1 && !!priorities.length;
    const activeList = hasPriority ? priorities : campaigns;

    const totalStr = `${activeList.length} ${hasPriority ? '' : 'Non-'}Priority game!`;
    this.container.logger.info(chalk`{bold.yellow Checking ${totalStr}.}`);

    this.queue.enqueue(...activeList);
    this.queue.state = hasPriority ? 2 : 3;
  }

  public override resetTask(): void {
    super.resetTask();
    this.container.ws.disconnect(true);
    this.queue.isSleeping = false;
  }
}
