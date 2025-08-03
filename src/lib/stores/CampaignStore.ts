import { container } from '@vegapunk/core';
import { strictGet } from '@vegapunk/utilities';
import { sortBy, truncate } from '@vegapunk/utilities/common';
import { waitForEach } from '@vegapunk/utilities/sleep';

import { Campaign } from '../struct/Campaign';
import { Drop } from '../struct/Drop';

export class CampaignStore {
  public get active(): Campaign[] {
    return this.values().filter((r) => !r.isStatus.expired && !r.isOffline);
  }

  public get sortedActive(): Campaign[] {
    return this.active.sort((campaignA, campaignB) => {
      const aEndAtTime = campaignA.endAt.getTime();
      const bEndAtTime = campaignB.endAt.getTime();
      if (campaignA.game.id === campaignB.game.id) {
        const aStartAtTime = campaignA.startAt.getTime();
        const bStartAtTime = campaignB.startAt.getTime();
        if (aStartAtTime !== bStartAtTime) {
          return aStartAtTime - bStartAtTime;
        }
        return aEndAtTime - bEndAtTime;
      }
      if (aEndAtTime !== bEndAtTime) {
        return aEndAtTime - bEndAtTime;
      }
      return 0;
    });
  }

  public get offline(): Campaign[] {
    return this.values().filter((r) => r.isOffline);
  }

  public get sortedOffline(): Campaign[] {
    return sortBy(this.offline, [(r) => r.endAt]);
  }

  public get upcoming(): Campaign[] {
    return this.values().filter((r) => r.isStatus.upcoming);
  }

  public get sortedUpcoming(): Campaign[] {
    return sortBy(this.upcoming, [(r) => r.startAt]);
  }

  public delete(id: string): void {
    this.campaigns.delete(id);
  }

  public async getProgress(): Promise<void> {
    const inventory = await container.api.inventory();
    const dropRewards = strictGet(inventory, 'data.currentUser.inventory.gameEventDrops', []);
    const dropProgress = strictGet(inventory, 'data.currentUser.inventory.dropCampaignsInProgress', []);
    await Promise.all([
      waitForEach(dropRewards, (data) => {
        const lastAwardedAt = new Date(data.lastAwardedAt);
        if (Date.now() - +lastAwardedAt >= this.rewardExpired) {
          return;
        }

        const drop = { id: data.id, lastAwardedAt };
        Campaign.rewards.update((r) => r.id === drop.id, drop, true);
      }),
      waitForEach(dropProgress, (campaign) => {
        const drops = campaign.timeBasedDrops;
        return waitForEach(drops, (data) => {
          const drop = new Drop({ ...data, campaignId: campaign.id, name: truncate(data.name) });
          Campaign.progress.update((r) => r.id === drop.id, drop, true);
        });
      }),
    ]);
  }

  public async getCampaigns(): Promise<void> {
    const { config } = container.client;

    const dropsDashboard = await container.api.dropsDashboard();
    const dropCampaigns = strictGet(dropsDashboard, 'data.currentUser.dropCampaigns', []);
    await waitForEach(dropCampaigns, (data) => {
      const campaign = new Campaign(this, data);
      const gameName = campaign.game.displayName;
      if (campaign.isStatus.expired) {
        this.campaigns.delete(campaign.id);
        return;
      }
      if (config.exclusionList.includes(gameName)) {
        return;
      }
      if (config.usePriorityConnected && campaign.isAccountConnected) {
        if (!config.priorityList.includes(gameName)) {
          config.priorityList.push(gameName);
        }
      }
      if (!config.isDropPriorityOnly || config.priorityList.includes(gameName)) {
        this.campaigns.set(campaign.id, campaign);
      }
    });
  }

  private values(): Campaign[] {
    return [...this.campaigns.values()];
  }

  private readonly campaigns: Map<string, Campaign> = new Map();
  private readonly rewardExpired: number = 2_592_000_000; // 1 month
}
