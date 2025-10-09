import { container } from '@vegapunk/core';
import { strictGet } from '@vegapunk/utilities';
import { sortBy, truncate } from '@vegapunk/utilities/common';
import { waitForEach } from '@vegapunk/utilities/sleep';

import { Campaign } from '../struct/Campaign';
import { Drop } from '../struct/Drop';

import type { DropCampaign } from '../api/types/DropsDashboard';
import type { DropCampaignsInProgress, GameEventDrop, TimeBasedDrop } from '../api/types/Inventory';

export class CampaignStore {
  private readonly campaigns: Map<string, Campaign> = new Map();
  private readonly rewardExpired: number = 2_592_000_000;

  public get active(): Campaign[] {
    return this.values().filter((campaign) => {
      return !campaign.status.expired && !campaign.isOffline;
    });
  }

  public get sortedActive(): Campaign[] {
    const dropCampaigns = sortBy(this.active, [(campaign) => campaign.endAt]);
    for (let i = 0; i < dropCampaigns.length; i++) {
      for (let j = i + 1; j < dropCampaigns.length; j++) {
        const left = dropCampaigns[i];
        const right = dropCampaigns[j];
        if (left.game.id !== right.game.id) {
          continue;
        }
        if (left.startAt <= right.startAt) {
          continue;
        }

        const campaign = dropCampaigns.splice(j, 1)[0];
        dropCampaigns.splice(i, 0, campaign);
      }
    }
    return dropCampaigns;
  }

  public get offline(): Campaign[] {
    return this.values().filter((campaign) => campaign.isOffline);
  }

  public get sortedOffline(): Campaign[] {
    return sortBy(this.offline, [(campaign) => campaign.endAt]);
  }

  public get upcoming(): Campaign[] {
    return this.values().filter((campaign) => campaign.status.upcoming);
  }

  public get sortedUpcoming(): Campaign[] {
    return sortBy(this.upcoming, [(campaign) => campaign.startAt]);
  }

  public delete(id: string): void {
    this.campaigns.delete(id);
  }

  public async getProgress(): Promise<void> {
    const inventory = await container.api.inventory();
    const dropRewards = strictGet(inventory, 'data.currentUser.inventory.gameEventDrops', []);
    const dropProgress = strictGet(inventory, 'data.currentUser.inventory.dropCampaignsInProgress', []);
    await Promise.all([
      waitForEach(dropRewards as GameEventDrop[], (data) => {
        const lastAwardedAt = new Date(data.lastAwardedAt);
        if (Date.now() - +lastAwardedAt >= this.rewardExpired) {
          return;
        }

        const drop = { id: data.id, lastAwardedAt };
        Campaign.rewards.update((reward) => reward.id === drop.id, drop, true);
      }),
      waitForEach(dropProgress as DropCampaignsInProgress[], (campaign) => {
        const drops = campaign.timeBasedDrops;
        return waitForEach(drops as TimeBasedDrop[], (data) => {
          const drop = new Drop({ ...data, campaignId: campaign.id, name: truncate(data.name) });
          Campaign.progress.update((drop) => drop.id === drop.id, drop, true);
        });
      }),
    ]);
  }

  public async getCampaigns(): Promise<void> {
    const { config } = container.client;

    const dropsDashboard = await container.api.dropsDashboard();
    const dropCampaigns = strictGet(dropsDashboard, 'data.currentUser.dropCampaigns', []);
    await waitForEach(dropCampaigns as DropCampaign[], (data) => {
      const campaign = new Campaign(this, data);
      const gameName = campaign.game.displayName;
      if (campaign.status.expired) {
        this.campaigns.delete(campaign.id);
        return;
      }
      if (config.exclusionList.has(gameName)) {
        return;
      }
      if (config.usePriorityConnected && campaign.isAccountConnected) {
        if (!config.priorityList.has(gameName)) {
          config.priorityList.add(gameName);
        }
      }
      if (!config.isPriorityOnly || config.priorityList.has(gameName)) {
        this.campaigns.set(campaign.id, campaign);
      }
    });
  }

  private values(): Campaign[] {
    return [...this.campaigns.values()];
  }
}
