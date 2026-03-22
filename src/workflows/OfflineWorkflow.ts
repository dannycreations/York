import { chalk } from '@vegapunk/utilities';
import { Array, Effect, Order, pipe, Ref, Schedule } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { calculatePriority, getDropStatus } from '../helpers/TwitchHelper';
import { CampaignStoreTag } from '../stores/CampaignStore';

import type { Campaign } from '../core/Schemas';
import type { MainState } from './MainWorkflow';

const processOfflineCampaign = (campaign: Campaign, state: MainState) =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const { isExpired } = getDropStatus(campaign.startAt, campaign.endAt, Date.now());

    if (isExpired) {
      yield* Ref.update(campaignStore.campaigns, (map) => {
        const next = new Map(map);
        next.delete(campaign.id);
        return next;
      });

      return;
    }

    const drops = yield* campaignStore.getDropsForCampaign(campaign.id).pipe(Effect.orDie);
    const hasNoDrops = drops.length === 0;

    if (hasNoDrops) {
      return;
    }

    const channels = yield* campaignStore.getChannelsForCampaign(campaign).pipe(Effect.orDie);
    const hasNoChannels = channels.length === 0;

    if (hasNoChannels) {
      return;
    }

    yield* Effect.logInfo(chalk`{bold.yellow ${campaign.name}} | {bold.yellow {strikethrough Offline}}`);
    yield* campaignStore.setOffline(campaign.id, false);

    const currentCampaign = yield* Ref.get(state.currentCampaign);
    const currentDrop = yield* Ref.get(state.currentDrop);
    const priority = calculatePriority(campaign, currentCampaign, currentDrop);

    yield* campaignStore.setPriority(campaign.id, priority);
  });

export const OfflineWorkflow = (state: MainState) =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const configStore = yield* ConfigStoreTag;

    yield* Effect.sleep('120 seconds');

    const loop = Effect.gen(function* () {
      const campaignsMap = yield* Ref.get(campaignStore.campaigns);
      const config = yield* configStore.get;

      const sortedOffline = pipe(
        Array.fromIterable(campaignsMap.values()),
        Array.filter((c) => c.isOffline),
        Array.sort(
          pipe(
            Order.number,
            Order.mapInput((c: Campaign) => (config.priorityList.has(c.game.displayName) ? 1 : 0)),
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
