import { chalk } from '@vegapunk/utilities';
import { Effect, Option, Ref, Schedule } from 'effect';

import { CampaignStoreTag } from '../services/CampaignStore';

import type { MainState } from './MainWorkflow';

export const UpcomingWorkflow = (state: MainState): Effect.Effect<void, never, CampaignStoreTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const sleepTime = 7_200_000;
    let nextRefresh = Date.now() + sleepTime;
    const isMainCallSleep = yield* Ref.make(false);

    yield* Effect.sleep('120 seconds');

    yield* Effect.repeat(
      Effect.gen(function* () {
        const now = Date.now();

        const campaignState = yield* Ref.get(campaignStore.state);
        const currentCampaign = yield* Ref.get(state.currentCampaign);
        const isMainCall = campaignState === 'Initial' && Option.isNone(currentCampaign);

        if (isMainCall || now >= nextRefresh) {
          yield* campaignStore.updateCampaigns.pipe(Effect.orDie);
          nextRefresh = now + sleepTime;
        }

        const upcoming = yield* campaignStore.getSortedUpcoming;
        if (upcoming.length === 0) {
          if (isMainCall) {
            const waitUntilTime = new Date(now + sleepTime).toLocaleString();
            yield* Effect.logInfo(chalk`{bold.yellow No upcoming campaigns}`);
            yield* Effect.logInfo(chalk`{bold.yellow Sleeping until ${waitUntilTime}}`);
          }
          return;
        }

        const next = upcoming[0];
        const waitMs = next.startAt.getTime() - now;

        if (waitMs > 0) {
          const alreadySleeping = yield* Ref.get(isMainCallSleep);
          if (!alreadySleeping && isMainCall) {
            yield* Ref.set(isMainCallSleep, true);
            const startTime = next.startAt.toLocaleString();
            const countStr = chalk`{bold.yellow ${upcoming.length} upcoming}`;

            yield* Effect.logInfo(chalk`{bold.yellow No active campaigns} | ${countStr}`);
            yield* Effect.logInfo(chalk`{bold.yellow Sleeping until ${startTime}}`);
          }
        } else {
          if (yield* Ref.get(isMainCallSleep)) {
            yield* Ref.set(isMainCallSleep, false);
            return;
          }

          if (isMainCall) {
            yield* Ref.set(campaignStore.state, 'All');
          }

          yield* Effect.logInfo(chalk`{bold.yellow ${next.name}} | {bold.yellow {strikethrough Upcoming}}`);

          const currentCampaignOpt = yield* Ref.get(state.currentCampaign);
          if (Option.isNone(currentCampaignOpt)) {
            yield* campaignStore.setPriority(next.id, 0);
          } else {
            const current = currentCampaignOpt.value;
            const currentDropOpt = yield* Ref.get(state.currentDrop);
            const isDifferentGame = current.game.id !== next.game.id;
            const shouldPrioritize = Option.isSome(currentDropOpt) && isDifferentGame && currentDropOpt.value.endAt >= next.endAt;

            yield* campaignStore.setPriority(next.id, shouldPrioritize ? current.priority + 1 : 0);
          }

          yield* Effect.sleep(`${Math.floor(Math.random() * 5000)} millis`);
        }
      }),
      Schedule.spaced('120 seconds'),
    ).pipe(Effect.asVoid);
  });
