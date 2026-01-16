import { chalk } from '@vegapunk/utilities';
import { Effect, Option, Ref, Schedule } from 'effect';

import { CampaignStoreTag } from '../services/CampaignStore';

import type { MainState } from './MainWorkflow';

/**
 * Manages upcoming campaigns and transitions them to active status when they start.
 *
 * @param state - The shared application state.
 * @returns An Effect that represents the upcoming campaign monitoring loop.
 */
export const UpcomingWorkflow = (state: MainState): Effect.Effect<void, never, CampaignStoreTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const sleepTime = 7_200_000;
    let nextRefresh = 0;

    yield* Effect.repeat(
      Effect.gen(function* () {
        const now = Date.now();
        if (now >= nextRefresh) {
          yield* campaignStore.updateCampaigns.pipe(Effect.orDie);
          nextRefresh = now + sleepTime;
        }

        const upcoming = yield* campaignStore.getSortedUpcoming;
        if (upcoming.length === 0) {
          yield* Effect.logInfo(chalk`{bold.yellow No upcoming campaigns}`);
          yield* Effect.sleep(`${sleepTime} millis`);
          return;
        }

        const next = upcoming[0];
        const waitMs = next.startAt.getTime() - now;

        if (waitMs > 0) {
          yield* Effect.logInfo(chalk`{bold.yellow No active campaigns} | {bold.yellow ${upcoming.length} upcoming}`);
          yield* Effect.logInfo(chalk`{bold.yellow Sleeping until ${next.startAt.toLocaleString()}}`);
          yield* Effect.sleep(`${waitMs} millis`);
        } else {
          yield* Effect.logInfo(chalk`{bold.yellow ${next.name}} | {bold.yellow {strikethrough Upcoming}}`);
          if ((yield* Ref.get(campaignStore.state)) === 'Initial') yield* Ref.set(campaignStore.state, 'All');

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

          yield* Effect.sleep('10 seconds');
        }
      }),
      Schedule.forever,
    );
  });
