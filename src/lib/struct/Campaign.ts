import { container } from '@vegapunk/core';
import { Queue } from '@vegapunk/struct';
import { chalk, strictGet } from '@vegapunk/utilities';
import { sortBy, truncate } from '@vegapunk/utilities/common';
import { waitForEach } from '@vegapunk/utilities/sleep';

import { GqlQuery } from '../api/AppGql';
import { dropStatus } from '../helpers/time.helper';
import { CampaignStore } from '../stores/CampaignStore';
import { Channel } from './Channel';
import { Drop } from './Drop';

import type { ChannelDrops } from '../api/types/ChannelDrops';
import type { Users } from '../api/types/ChannelStreams';
import type { DropCampaign } from '../api/types/DropsDashboard';
import type { Edge } from '../api/types/GameDirectory';
import type { DropStatusResult } from '../helpers/time.helper';

export interface Game {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly displayName: string;
}

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

  private allowChannels?: string[];

  public priority: number = 0;
  public isOffline: boolean = false;

  public constructor(
    private readonly store: CampaignStore,
    readonly campaign: DropCampaign,
  ) {
    this.id = campaign.id;
    this.name = truncate(campaign.name.trim());
    this.game = campaign.game as Game;
    this.startAt = new Date(campaign.startAt);
    this.endAt = new Date(campaign.endAt);
    this.isAccountConnected = campaign.self.isAccountConnected;
  }

  public get status(): DropStatusResult {
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
      if (!this.channels.last && Campaign.trackMinutesWatched === 1) {
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
      Campaign.progress.delete((reward) => reward.id === selectDrop.id);
      await waitForEach(selectDrop.benefits as string[], (id) => {
        const drop = { id, lastAwardedAt: new Date() };
        Campaign.rewards.update((reward) => reward.id === drop.id, drop, true);
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

    this.allowChannels = dropDetail.allow.channels?.map((channel) => channel.name) ?? [];
    Object.assign(this, { name: truncate(dropDetail.name.trim()), game: { ...dropDetail.game } });

    const activeDrops: Drop[] = [];
    const sortedTimeBasedDrops = sortBy(dropDetail.timeBasedDrops, [(drop) => drop.requiredMinutesWatched]);
    await waitForEach(sortedTimeBasedDrops, (data) => {
      const exist = Campaign.progress.find((drop) => drop.id === data.id);
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
      if (!exist && drop.benefits.some((benefit) => this.isClaimed(benefit, drop.startAt))) {
        return;
      }

      activeDrops.push(drop);
    });
    await waitForEach(activeDrops, (drop, i) => {
      Object.assign(drop, { name: truncate(`${i + 1}/${activeDrops.length}, ${drop.name}`) });
      this.drops.update((drop) => drop.id === drop.id, drop, true);
    });
  }

  public async getChannels(): Promise<void> {
    const gameId = this.game.id;
    const foundChannels: Channel[] = [];
    if (this.allowChannels?.length) {
      const logins = this.allowChannels.slice(0, 30);
      const stream = await container.api.channelStreams(logins);
      const users = strictGet(stream, 'data.users', []);
      await waitForEach(users as Users[], (user) => {
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
      await waitForEach(users as Edge[], (user) => {
        const id = user.node.broadcaster.id;
        const login = user.node.broadcaster.login;
        const channel = new Channel({ id, login, gameId });
        foundChannels.push(channel);
      });
    }
    if (!foundChannels.length) {
      return;
    }

    const channel = await container.api.graphql<ChannelDrops>(foundChannels.map((c) => GqlQuery.channelDrops(c.id)));
    const channelFilter = channel.filter((c) => c.data.channel.viewerDropCampaigns?.some((campaign) => campaign.id === this.id));
    this.channels.enqueue(...foundChannels.filter((fChannel) => channelFilter.some((channel) => channel.data.channel.id === fChannel.id)));
  }

  private isClaimed(benefitId: string, startAt: Date): boolean {
    const reward = Campaign.rewards.find((r) => r.id === benefitId);
    return reward ? reward.lastAwardedAt >= startAt : false;
  }
}

export interface Reward {
  readonly id: string;
  readonly lastAwardedAt: Date;
}
