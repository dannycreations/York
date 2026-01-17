import { chalk } from '@vegapunk/utilities';
import { Array, Effect, Option, Ref, Schedule } from 'effect';

import { getDropStatus } from '../helpers/TwitchHelper';
import { CampaignStoreTag } from '../stores/CampaignStore';

import type { ClientConfig } from '../core/Config';
import type { Campaign } from '../core/Schemas';
import type { CampaignStore } from '../stores/CampaignStore';
import type { StoreClient } from '../structures/StoreClient';
import type { MainState } from './MainWorkflow';

const processOfflineCampaign = (campaign: Campaign, state: MainState, campaignStore: CampaignStore): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (getDropStatus(campaign.startAt, campaign.endAt).isExpired) {
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

      const currentCampaignOpt = yield* Ref.get(state.currentCampaign);
      if (Option.isNone(currentCampaignOpt)) {
        yield* campaignStore.setPriority(campaign.id, 0);
      } else {
        const current = currentCampaignOpt.value;
        const currentDropOpt = yield* Ref.get(state.currentDrop);
        const isDifferentGame = current.game.id !== campaign.game.id;
        const shouldPrioritize = Option.isSome(currentDropOpt) && isDifferentGame && currentDropOpt.value.endAt >= campaign.endAt;

        yield* campaignStore.setPriority(campaign.id, shouldPrioritize ? current.priority + 1 : 0);
      }
    }
  });

export const OfflineWorkflow = (state: MainState, configStore: StoreClient<ClientConfig>): Effect.Effect<void, never, CampaignStoreTag> =>
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
