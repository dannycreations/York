import { chalk } from '@vegapunk/utilities';
import { Effect, Option, Ref, Schedule } from 'effect';

import { calculatePriority } from '../helpers/TwitchHelper';
import { CampaignStoreState, CampaignStoreTag } from '../stores/CampaignStore';

import type { Campaign } from '../core/Schemas';
import type { CampaignStore } from '../stores/CampaignStore';
import type { MainState } from './MainWorkflow';

const processUpcomingCampaign = (
  next: Campaign,
  upcomingCount: number,
  state: MainState,
  campaignStore: CampaignStore,
  isMainCall: boolean,
  isMainCallSleep: Ref.Ref<boolean>,
) =>
  Effect.gen(function* () {
    const waitMs = next.startAt.getTime() - Date.now();

    if (waitMs > 0) {
      const alreadySleeping = yield* Ref.get(isMainCallSleep);
      if (!alreadySleeping && isMainCall) {
        yield* Ref.set(isMainCallSleep, true);
        yield* Effect.logInfo(chalk`{bold.yellow No active campaigns} | {bold.yellow ${upcomingCount} upcoming}`);
        yield* Effect.logInfo(chalk`{bold.yellow Sleeping until ${next.startAt.toLocaleString()}}`);
      }
      return;
    }

    if (yield* Ref.get(isMainCallSleep)) {
      return yield* Ref.set(isMainCallSleep, false);
    }

    if (isMainCall) {
      yield* Ref.set(campaignStore.state, CampaignStoreState.All());
    }

    yield* Effect.logInfo(chalk`{bold.yellow ${next.name}} | {bold.yellow {strikethrough Upcoming}}`);

    const currentCampaign = yield* Ref.get(state.currentCampaign);
    const currentDrop = yield* Ref.get(state.currentDrop);
    const priority = calculatePriority(next, currentCampaign, currentDrop);

    yield* campaignStore.setPriority(next.id, priority);

    yield* Effect.sleep(`${Math.floor(Math.random() * 5000)} millis`);
  });

export const UpcomingWorkflow = (state: MainState) =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const sleepTime = 7_200_000;
    const nextRefreshRef = yield* Ref.make(Date.now() + sleepTime);
    const isMainCallSleep = yield* Ref.make(false);

    yield* Effect.sleep('120 seconds');

    const loop = Effect.gen(function* () {
      const now = Date.now();
      const nextRefresh = yield* Ref.get(nextRefreshRef);

      const campaignState = yield* Ref.get(campaignStore.state);
      const currentCampaign = yield* Ref.get(state.currentCampaign);
      const isMainCall = campaignState._tag === 'Initial' && Option.isNone(currentCampaign);

      if (isMainCall || now >= nextRefresh) {
        yield* campaignStore.updateCampaigns.pipe(Effect.orDie);
        yield* Ref.set(nextRefreshRef, now + sleepTime);
      }

      const upcoming = yield* campaignStore.getSortedUpcoming;
      if (upcoming.length === 0) {
        if (isMainCall) {
          yield* Effect.logInfo(chalk`{bold.yellow No upcoming campaigns}`);
          yield* Effect.logInfo(chalk`{bold.yellow Sleeping until ${new Date(now + sleepTime).toLocaleString()}}`);
        }
        return;
      }

      yield* processUpcomingCampaign(upcoming[0], upcoming.length, state, campaignStore, isMainCall, isMainCallSleep);
    });

    yield* Effect.repeat(loop, Schedule.spaced('120 seconds'));
  });
