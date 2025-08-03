import { container } from '@vegapunk/core';
import { chalk, RequiredExcept, strictHas } from '@vegapunk/utilities';
import { truncate } from '@vegapunk/utilities/common';

import { TimeBasedDrop as InventoryDrop } from '../api/types/Inventory';
import { DropStatus, dropStatus } from '../helpers/time.helper';

export class Drop {
  public readonly id: string;
  public readonly name: string;
  public readonly benefits: string[];
  public readonly campaignId: string;
  public readonly startAt: Date;
  public readonly endAt: Date;
  public readonly requiredMinutesWatched: number;

  public isClaimed: boolean;
  public hasPreconditionsMet: boolean;
  public currentMinutesWatched: number;

  public constructor(drop: DropContext) {
    this.id = drop.id;
    this.name = truncate(drop.benefitEdges[0].benefit.name.trim());
    this.benefits = drop.benefitEdges.map((r) => r.benefit.id);
    this.campaignId = drop.campaignId;
    this.startAt = new Date(drop.startAt);
    this.endAt = new Date(drop.endAt);
    this.requiredMinutesWatched = drop.requiredMinutesWatched;
    this.hasPreconditionsMet = drop.self?.hasPreconditionsMet ?? true;
    this.currentMinutesWatched = drop.self?.currentMinutesWatched || 0;

    this.isClaimed = drop.requiredSubs > 0 || drop.self?.isClaimed || false;
    this.dropInstanceID = drop.self?.dropInstanceID || undefined;
  }

  public get isStatus(): DropStatus {
    if (this.isClaimed) {
      return { expired: true, upcoming: false };
    }
    if (this.hasAward) {
      return { expired: false, upcoming: false };
    }

    const minutesLeft = this.requiredMinutesWatched - this.currentMinutesWatched;
    return dropStatus(this.startAt, this.endAt, minutesLeft);
  }

  public get isMinutesWatchedMet(): boolean {
    return this.currentMinutesWatched >= this.requiredMinutesWatched + 1;
  }

  public get hasAward(): boolean {
    return !!this.dropInstanceID;
  }

  public async claimDrops(dropID: string = this.dropInstanceID!): Promise<boolean> {
    if (!container.client.config.isClaimDrops || !dropID) {
      return false;
    }

    const res = await container.api.claimDrops(dropID);
    if (!strictHas(res, 'data.claimDropRewards')) {
      return false;
    }

    this.dropInstanceID = undefined;
    container.logger.info(chalk`{green ${this.name}} | {yellow Drops claimed}.`);
    return true;
  }

  private dropInstanceID?: string;
}

export interface DropContext extends RequiredExcept<InventoryDrop, 'self' | 'campaign'> {
  campaignId: string;
}
