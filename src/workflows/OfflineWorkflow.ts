import { chalk } from '@vegapunk/utilities';
import { Array, Effect, Order, pipe, Ref, Schedule } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { calculatePriority, getDropStatus } from '../helpers/TwitchHelper';
import { CampaignServiceTag } from '../services/CampaignService';

import type { Campaign } from '../core/Schemas';
import type { MainState } from './MainWorkflow';

const processOfflineCampaign = (campaign: Campaign, state: MainState) =>
  Effect.gen(function* () {
    if (campaign.game === null) {
      return;
    }

    const campaignService = yield* CampaignServiceTag;
    const { isExpired } = getDropStatus(campaign.startAt, campaign.endAt, Date.now());

    if (isExpired) {
      yield* Ref.update(campaignService.campaigns, (map) => {
        const next = new Map(map);
        next.delete(campaign.id);
        return next;
      });

      return;
    }

    const drops = yield* campaignService.getDropsForCampaign(campaign.id).pipe(Effect.orDie);

    if (drops.length === 0) {
      return;
    }

    const channels = yield* campaignService.getChannelsForCampaign(campaign).pipe(Effect.orDie);

    if (channels.length === 0) {
      return;
    }

    yield* Effect.logInfo(chalk`{bold.yellow ${campaign.name}} | {bold.green Campaigns online}`);
    yield* campaignService.setOffline(campaign.id, false);

    const currentCampaign = yield* Ref.get(state.currentCampaign);
    const currentDrop = yield* Ref.get(state.currentDrop);
    const priority = calculatePriority(campaign, currentCampaign, currentDrop);

    yield* campaignService.setPriority(campaign.id, priority);
  });

export const OfflineWorkflow = (state: MainState) =>
  Effect.gen(function* () {
    const campaignService = yield* CampaignServiceTag;
    const configStore = yield* ConfigStoreTag;

    yield* Effect.sleep('120 seconds');

    const loop = Effect.gen(function* () {
      const campaignsMap = yield* Ref.get(campaignService.campaigns);
      const config = yield* configStore.get;

      const sortedOffline = pipe(
        Array.fromIterable(campaignsMap.values()),
        Array.filter((c) => c.isOffline && c.game !== null),
        Array.sort(
          pipe(
            Order.number,
            Order.mapInput((c: Campaign) => (c.game !== null && config.priorityList.has(c.game.displayName) ? 1 : 0)),
            Order.reverse,
          ),
        ),
      );

      yield* Effect.forEach(sortedOffline, (campaign) => processOfflineCampaign(campaign, state), {
        discard: true,
      });

      yield* Effect.sleep(`${Math.floor(Math.random() * 5000)} millis`);
    });

    yield* Effect.repeat(loop, Schedule.spaced('120 seconds'));
  });
