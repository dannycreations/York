import { container } from '@vegapunk/core';
import { Queue } from '@vegapunk/struct';
import { chalk, strictGet } from '@vegapunk/utilities';
import { sortBy, truncate } from '@vegapunk/utilities/common';
import { waitForEach } from '@vegapunk/utilities/sleep';

import { GqlQuery } from '../api/TwitchGql';
import { ChannelDrops } from '../api/types/ChannelDrops';
import { DropCampaign } from '../api/types/DropsDashboard';
import { DropStatus, dropStatus } from '../helpers/time.helper';
import { CampaignStore } from '../stores/CampaignStore';
import { Channel } from './Channel';
import { Drop } from './Drop';

export class Campaign {
  public static readonly progress: Queue<Drop> = new Queue();
  public static readonly rewards: Queue<Reward> = new Queue();
  public static trackMinutesWatched: number = 0;

  public readonly id: string;
  public readonly name: string;
  public readonly game: Game;
  public readonly startAt: Date;
  public readonly endAt: Date;
  public readonly isAccountConnected: boolean;

  public readonly drops: Queue<Drop> = new Queue();
  public readonly channels: Queue<Channel> = new Queue();

  public priority: number = 0;
  public isOffline: boolean = false;

  public constructor(
    private store: CampaignStore,
    campaign: DropCampaign,
  ) {
    this.id = campaign.id;
    this.name = truncate(campaign.name.trim());
    this.game = campaign.game as Game;
    this.startAt = new Date(campaign.startAt);
    this.endAt = new Date(campaign.endAt);
    this.isAccountConnected = campaign.self.isAccountConnected;
  }

  public get isStatus(): DropStatus {
    return dropStatus(this.startAt, this.endAt);
  }

  public async watch(): Promise<boolean> {
    const selectDrop = this.drops.peek();
    if (!selectDrop) {
      return false;
    }

    const selectChannel = this.channels.peek();
    if (!selectChannel) {
      return false;
    }

    const isSuccessWatch = await selectChannel.watch();
    if (isSuccessWatch) {
      if (Campaign.trackMinutesWatched === 1) {
        if (this.channels.last && this.channels.last.id !== selectChannel.id) {
          await this.channels.last.unlisten();
        }
        await selectChannel.listen();
      }

      const localMinutesWatched = ++selectDrop.currentMinutesWatched;
      const currentProgress = chalk`{green ${localMinutesWatched}/${selectDrop.requiredMinutesWatched}}`;
      container.logger.info(chalk`{green ${selectDrop.name}} | {green ${selectChannel.login}} | ${currentProgress}.`);

      if (Campaign.trackMinutesWatched >= 20) {
        Campaign.trackMinutesWatched = 0;

        await this.store.getProgress();
        await this.getDrops();
        if (localMinutesWatched - selectDrop.currentMinutesWatched >= 20) {
          selectChannel.isOnline = false;
        }
      }
    }

    if (!selectChannel.isOnline) {
      this.channels.dequeue();
    }
    return isSuccessWatch;
  }

  public async claimDrops(): Promise<boolean> {
    const selectDrop = this.drops.peek();
    if (!selectDrop) {
      return false;
    }

    const isSuccessClaim = await selectDrop.claimDrops();
    if (isSuccessClaim) {
      Campaign.progress.delete((r) => r.id === selectDrop.id);
      await waitForEach(selectDrop.benefits, (id) => {
        const drop = { id, lastAwardedAt: new Date() };
        Campaign.rewards.update((r) => r.id === drop.id, drop, true);
      });
    }
    return isSuccessClaim;
  }

  public async getDrops(): Promise<void> {
    const campaignDetail = await container.api.campaignDetails({ dropID: this.id });
    const dropDetail = strictGet(campaignDetail, 'data.user.dropCampaign');
    if (!dropDetail) {
      return;
    }

    this.allowChannels = dropDetail.allow.channels?.map((r) => r.name) ?? [];
    Object.assign(this, { name: truncate(dropDetail.name.trim()), game: { ...dropDetail.game } });

    const activeDrops: Drop[] = [];
    const sortedTimeBasedDrops = sortBy(dropDetail.timeBasedDrops, [(r) => r.requiredMinutesWatched]);
    await waitForEach(sortedTimeBasedDrops, (data) => {
      const exist = Campaign.progress.find((r) => r.id === data.id);
      const drop = exist ?? new Drop({ campaignId: this.id, ...data });
      if (drop.isStatus.expired) {
        return;
      }
      if (drop.isStatus.upcoming) {
        return;
      }
      if (drop.isMinutesWatchedMet && !container.client.config.isClaimDrops) {
        return;
      }
      if (!exist && drop.benefits.some((r) => this.isClaimed(r, drop.startAt))) {
        return;
      }

      activeDrops.push(drop);
    });
    await waitForEach(activeDrops, (drop, i) => {
      Object.assign(drop, { name: truncate(`${i + 1}/${activeDrops.length}, ${drop.name}`) });
      this.drops.update((r) => r.id === drop.id, drop, true);
    });
  }

  public async getChannels(): Promise<void> {
    const gameId = this.game.id;
    const foundChannels: Channel[] = [];
    if (this.allowChannels?.length) {
      const logins = this.allowChannels.slice(0, 30);
      const stream = await container.api.channelStreams(logins);
      const users = strictGet(stream, 'data.users', []);
      await waitForEach(users, (user) => {
        if (!user?.stream) {
          return;
        }

        const id = user.id;
        const login = user.login;
        const channel = new Channel({ id, login, gameId });
        foundChannels.push(channel);
      });
    } else {
      const directory = await container.api.gameDirectory(this.game.slug);
      const users = strictGet(directory, 'data.game.streams.edges', []);
      await waitForEach(users, (user) => {
        const id = user.node.broadcaster.id;
        const login = user.node.broadcaster.login;
        const channel = new Channel({ id, login, gameId });
        foundChannels.push(channel);
      });
    }
    if (!foundChannels.length) {
      return;
    }

    const channel = await container.api.graphql<ChannelDrops>(foundChannels.map((r) => GqlQuery.channelDrops(r.id)));
    const channelFilter = channel.filter((r) => r.data.channel.viewerDropCampaigns?.some((r) => r.id === this.id));
    this.channels.enqueue(...foundChannels.filter((r) => channelFilter.some((s) => s.data.channel.id === r.id)));
  }

  private isClaimed(benefitId: string, startAt: Date): boolean {
    const reward = Campaign.rewards.find((r) => r.id === benefitId);
    return reward ? reward.lastAwardedAt >= startAt : false;
  }

  private allowChannels?: string[];
}

export interface Reward {
  id: string;
  lastAwardedAt: Date;
}

export interface Game {
  id: string;
  name: string;
  slug: string;
  displayName: string;
}
