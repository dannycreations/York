import { chalk } from '@vegapunk/utilities';
import { Array, Effect, Ref, Schedule } from 'effect';

import { calculatePriority, getDropStatus } from '../helpers/TwitchHelper';
import { CampaignStoreTag } from '../stores/CampaignStore';

import type { ClientConfig } from '../core/Config';
import type { Campaign } from '../core/Schemas';
import type { CampaignStore } from '../stores/CampaignStore';
import type { StoreClient } from '../structures/StoreClient';
import type { MainState } from './MainWorkflow';

const processOfflineCampaign = (campaign: Campaign, state: MainState, campaignStore: CampaignStore): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (getDropStatus(campaign.startAt, campaign.endAt, Date.now()).isExpired) {
      yield* Ref.update(campaignStore.campaigns, (map) => {
        const next = new Map(map);
        next.delete(campaign.id);
        return next;
      });
      return;
    }

    const drops = yield* campaignStore.getDropsForCampaign(campaign.id).pipe(Effect.orDie);
    if (drops.length === 0) {
      return;
    }

    const channels = yield* campaignStore.getChannelsForCampaign(campaign).pipe(Effect.orDie);
    if (channels.length > 0) {
      yield* Effect.logInfo(chalk`{bold.yellow ${campaign.name}} | {bold.yellow {strikethrough Offline}}`);
      yield* campaignStore.setOffline(campaign.id, false);

      const currentCampaign = yield* Ref.get(state.currentCampaign);
      const currentDrop = yield* Ref.get(state.currentDrop);
      const priority = calculatePriority(campaign, currentCampaign, currentDrop);

      yield* campaignStore.setPriority(campaign.id, priority);
    }
  });

export const OfflineWorkflow = (state: MainState, configStore: StoreClient<ClientConfig>): Effect.Effect<void, never, CampaignStore> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;

    yield* Effect.sleep('120 seconds');

    yield* Effect.repeat(
      Effect.gen(function* () {
        const campaignsMap = yield* Ref.get(campaignStore.campaigns);
        const config = yield* configStore.get;

        const sortedOffline = Array.fromIterable(campaignsMap.values())
          .filter((c) => c.isOffline)
          .sort((a, b) => {
            const aPri = config.priorityList.has(a.game.displayName) ? 1 : 0;
            const bPri = config.priorityList.has(b.game.displayName) ? 1 : 0;
            return bPri - aPri;
          });

        yield* Effect.forEach(sortedOffline, (campaign) => processOfflineCampaign(campaign, state, campaignStore), {
          discard: true,
          concurrency: 1,
        });

        yield* Effect.sleep(`${Math.floor(Math.random() * 5000)} millis`);
      }),
      Schedule.spaced('120 seconds'),
    ).pipe(Effect.asVoid);
  });
