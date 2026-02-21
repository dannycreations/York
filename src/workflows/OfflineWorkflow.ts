import { chalk } from '@vegapunk/utilities';
import { Array, Effect, Order, pipe, Ref, Schedule } from 'effect';

import { calculatePriority, getDropStatus } from '../helpers/TwitchHelper';
import { CampaignStoreTag } from '../stores/CampaignStore';

import type { ClientConfig } from '../core/Config';
import type { Campaign } from '../core/Schemas';
import type { CampaignStore } from '../stores/CampaignStore';
import type { StoreClient } from '../structures/StoreClient';
import type { MainState } from './MainWorkflow';

const processOfflineCampaign = (campaign: Campaign, state: MainState, campaignStore: CampaignStore) =>
  Effect.gen(function* () {
    const { isExpired } = getDropStatus(campaign.startAt, campaign.endAt, Date.now());

    if (isExpired) {
      return yield* Ref.update(campaignStore.campaigns, (map) => {
        const next = new Map(map);
        next.delete(campaign.id);
        return next;
      });
    }

    const drops = yield* campaignStore.getDropsForCampaign(campaign.id).pipe(Effect.orDie);
    if (Array.isEmptyReadonlyArray(drops)) return;

    const channels = yield* campaignStore.getChannelsForCampaign(campaign).pipe(Effect.orDie);
    if (Array.isNonEmptyReadonlyArray(channels)) {
      yield* Effect.logInfo(chalk`{bold.yellow ${campaign.name}} | {bold.yellow {strikethrough Offline}}`);
      yield* campaignStore.setOffline(campaign.id, false);

      const currentCampaign = yield* Ref.get(state.currentCampaign);
      const currentDrop = yield* Ref.get(state.currentDrop);
      const priority = calculatePriority(campaign, currentCampaign, currentDrop);

      yield* campaignStore.setPriority(campaign.id, priority);
    }
  });

export const OfflineWorkflow = (state: MainState, configStore: StoreClient<ClientConfig>) =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;

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

      yield* Effect.forEach(sortedOffline, (campaign) => processOfflineCampaign(campaign, state, campaignStore), {
        discard: true,
      });

      yield* Effect.sleep(`${Math.floor(Math.random() * 5000)} millis`);
    });

    yield* Effect.repeat(loop, Schedule.spaced('120 seconds'));
  });
