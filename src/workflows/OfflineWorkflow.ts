import { chalk } from '@vegapunk/utilities';
import { Array, Effect, Option, Order, pipe, Ref, Schedule } from 'effect';

import { ConfigStoreTag, gamePriorityRank } from '../core/Config.js';
import { calculatePriority, getDropStatus } from '../helpers/TwitchHelper.js';
import { CampaignServiceTag } from '../services/CampaignService.js';

import type { Campaign } from '../core/Schemas.js';
import type { MainState } from '../core/State.js';

const warn = (stage: string, message: string) => Effect.logWarning(chalk`{yellow Offline check error (${stage}): ${message}}`);

const processOfflineCampaign = (campaign: Campaign, state: MainState) =>
  Effect.gen(function* () {
    const campaignService = yield* CampaignServiceTag;

    const channels = yield* campaignService
      .getChannelsForCampaign(campaign)
      .pipe(Effect.catchAll((e) => warn('channels', e.message).pipe(Effect.as([]))));

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
      const campaigns = yield* campaignService.listCampaigns;
      const config = yield* configStore.get;
      const now = Date.now();

      const [expired, pending] = pipe(
        campaigns,
        Array.filter((c) => c.isOffline && c.game !== null),
        Array.partition((c) => !getDropStatus(c.startAt, c.endAt, now).isExpired),
      );

      yield* Effect.forEach(expired, (c) => campaignService.removeCampaign(c.id), { discard: true });

      const sortedOffline = Array.sort(
        pending,
        pipe(
          Order.number,
          Order.mapInput((c: Campaign) => gamePriorityRank(config, c.game?.displayName)),
          Order.reverse,
        ),
      );

      // Warming the details up front turns the sweep's per-campaign lookups into
      // a single batched request; the drop checks below then cost nothing.
      yield* campaignService.primeCampaignDetails(sortedOffline.map((c) => c.id)).pipe(Effect.catchAll((e) => warn('details', e.message)));

      // Resolving drops also refreshes the stored campaign, so the survivors are
      // re-read to discover channels against an up-to-date allow list.
      const withDrops = yield* Effect.forEach(sortedOffline, (campaign) =>
        campaignService.getDropsForCampaign(campaign.id).pipe(
          Effect.flatMap((drops) => (drops.length === 0 ? Effect.succeedNone : campaignService.getCampaign(campaign.id))),
          Effect.catchAll((e) => warn('drops', e.message).pipe(Effect.as(Option.none<Campaign>()))),
        ),
      ).pipe(Effect.map(Array.getSomes));

      // Channel discovery is the expensive half, so only the campaigns that
      // still have drops are warmed, again in one batch.
      yield* campaignService.primeCampaignChannels(withDrops).pipe(Effect.catchAll((e) => warn('channels', e.message)));
      yield* Effect.forEach(withDrops, (campaign) => processOfflineCampaign(campaign, state), { discard: true });
      yield* Effect.sleep(`${Math.floor(Math.random() * 5000)} millis`);
    });

    yield* Effect.repeat(loop, Schedule.spaced('120 seconds'));
  });
