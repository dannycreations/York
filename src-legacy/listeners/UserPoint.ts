import { Listener } from '@vegapunk/core';
import { strictGet } from '@vegapunk/utilities';
import { uniqueId } from '@vegapunk/utilities/common';

import { Tasks, WsEvents } from '../lib/constants/Enum';
import { Channel } from '../lib/struct/Channel';
import { writeDebugFile } from '../lib/utils/dev.util';

import type { ResponseContent } from '../lib/api/types/WebSocket';
import type { DropMainTask } from '../tasks/DropMain';

export class UserPointListener extends Listener<WsEvents.UserPoint> {
  private readonly watchTime: number = 900_000;
  private nextClaim: number = 0;

  public constructor(context: Listener.LoaderContext) {
    super(context, { event: WsEvents.UserPoint });
  }

  public async run(message: ResponseContent): Promise<void> {
    const taskStores = this.container.stores.get('tasks');
    const { queue } = taskStores.get(Tasks.DropMain) as DropMainTask;

    const selectChannel = queue.peek()?.channels.peek();
    if (!selectChannel) {
      return;
    }

    await writeDebugFile(message, `UserPoint-${message.type ? message.type : uniqueId()}`);
    switch (message.type) {
      case 'claim-available':
        return this.pointClaim(message as PointClaim, selectChannel);
      case 'points-earned':
        return this.pointProgress(message as PointProgress, selectChannel);
    }
  }

  private async pointClaim(message: PointClaim, selectChannel: Channel): Promise<void> {
    if (message.data.claim.channel_id !== selectChannel.id) {
      return;
    }

    await selectChannel.claimPoints(message.data.claim.id);
    this.nextClaim = Date.now() + this.watchTime;
  }

  private async pointProgress(message: PointProgress, selectChannel: Channel): Promise<void> {
    if (this.nextClaim >= Date.now() || message.data.channel_id !== selectChannel.id) {
      return;
    }

    const channel = await this.container.api.channelPoints(selectChannel.login);
    const points = strictGet(channel, 'data.community.channel.self.communityPoints');
    await selectChannel.claimPoints(strictGet(points, 'availableClaim.id'));
    this.nextClaim = Date.now() + this.watchTime;
  }
}

type PointClaim = ResponseContent<
  'claim-available',
  {
    readonly timestamp: string;
    readonly claim: {
      readonly id: string;
      readonly user_id: string;
      readonly channel_id: string;
      readonly point_gain: {
        readonly user_id: string;
        readonly channel_id: string;
        readonly total_points: number;
        readonly baseline_points: number;
        readonly reason_code: string;
        readonly multipliers: readonly string[];
      };
      readonly created_at: string;
    };
  }
>;

type PointProgress = ResponseContent<
  'points-earned',
  {
    readonly timestamp: string;
    readonly channel_id: string;
    readonly point_gain: {
      readonly user_id: string;
      readonly channel_id: string;
      readonly total_points: number;
      readonly baseline_points: number;
      readonly reason_code: string;
      readonly multipliers: readonly string[];
    };
    readonly balance: {
      readonly user_id: string;
      readonly channel_id: string;
      readonly balance: number;
    };
  }
>;
