import { chalk } from '@vegapunk/utilities';
import { Effect, Option, Ref, Schedule } from 'effect';

import { calculatePriority } from '../helpers/TwitchHelper.js';
import { CampaignServiceTag } from '../services/CampaignService.js';

import type { Campaign } from '../core/Schemas.js';
import type { MainState } from '../core/State.js';

const REFRESH_INTERVAL_MS = 7_200_000;

const processUpcomingCampaign = (next: Campaign, upcomingCount: number, state: MainState, isMainCall: boolean, isMainCallSleep: Ref.Ref<boolean>) =>
  Effect.gen(function* () {
    if (next.game === null) {
      return;
    }

    const campaignService = yield* CampaignServiceTag;

    const waitMs = next.startAt.getTime() - Date.now();
    if (waitMs > 0) {
      if (yield* Ref.get(isMainCallSleep)) {
        return;
      }

      if (!isMainCall) {
        return;
      }

      yield* Ref.set(isMainCallSleep, true);
      yield* Effect.logInfo(chalk`{bold.yellow No active campaigns} | {bold.yellow ${upcomingCount} upcoming}`);
      yield* Effect.logInfo(chalk`{bold.yellow Sleeping until ${next.startAt.toLocaleString()}}`);
      return;
    }

    const wasSleeping = yield* Ref.get(isMainCallSleep);

    if (wasSleeping) {
      yield* Ref.set(isMainCallSleep, false);
      return;
    }

    if (isMainCall) {
      yield* campaignService.setMode('All');
    }

    yield* Effect.logInfo(chalk`{bold.yellow ${next.name}} | {bold.yellow {strikethrough Upcoming}}`);

    const currentCampaign = yield* Ref.get(state.currentCampaign);
    const currentDrop = yield* Ref.get(state.currentDrop);
    const priority = calculatePriority(next, currentCampaign, currentDrop);

    yield* campaignService.setPriority(next.id, priority);

    yield* Effect.sleep(`${Math.floor(Math.random() * 5000)} millis`);
  });

export const UpcomingWorkflow = (state: MainState) =>
  Effect.gen(function* () {
    const campaignService = yield* CampaignServiceTag;
    const nextRefreshRef = yield* Ref.make(Date.now() + REFRESH_INTERVAL_MS);
    const isMainCallSleep = yield* Ref.make(false);

    yield* Effect.sleep('120 seconds');

    const loop = Effect.gen(function* () {
      const now = Date.now();
      const nextRefresh = yield* Ref.get(nextRefreshRef);

      const campaignMode = yield* campaignService.getMode;
      const currentCampaign = yield* Ref.get(state.currentCampaign);
      const isMainCall = campaignMode === 'Initial' && Option.isNone(currentCampaign);

      if (isMainCall || now >= nextRefresh) {
        yield* campaignService.updateCampaigns.pipe(Effect.catchAll((e) => Effect.logWarning(chalk`{yellow Upcoming check error: ${e.message}}`)));
        yield* Ref.set(nextRefreshRef, Date.now() + REFRESH_INTERVAL_MS);
      }

      const upcoming = yield* campaignService.getSortedUpcoming;
      if (upcoming.length === 0) {
        if (isMainCall) {
          yield* Effect.logInfo(chalk`{bold.yellow No upcoming campaigns}`);
          yield* Effect.logInfo(chalk`{bold.yellow Sleeping until ${new Date(now + REFRESH_INTERVAL_MS).toLocaleString()}}`);
        }
        return;
      }

      yield* processUpcomingCampaign(upcoming[0], upcoming.length, state, isMainCall, isMainCallSleep);
    });

    yield* Effect.repeat(loop, Schedule.spaced('120 seconds'));
  });
