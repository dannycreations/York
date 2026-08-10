import { chalk } from '@vegapunk/utilities';
import { Context, Effect, Layer, Option, Ref } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi.js';
import { TwitchSocketTag } from '../api/TwitchSocket.js';
import { resetChannel } from '../helpers/ChannelHelper.js';
import { CampaignServiceTag } from './CampaignService.js';

import type { TwitchApiError } from '../api/TwitchApi.js';
import type { Campaign, Drop } from '../core/Schemas.js';
import type { MainState } from '../core/State.js';

const MAX_CLAIM_ATTEMPTS = 5;

export interface DropService {
  readonly claimDropSequence: (campaign: Campaign, drop: Drop, state: MainState) => Effect.Effect<void>;
  readonly syncDropProgress: (drop: Drop, state: MainState) => Effect.Effect<void, TwitchApiError>;
}

export class DropServiceTag extends Context.Tag('@services/DropService')<DropServiceTag, DropService>() {}

export const DropServiceLayer = Layer.effect(
  DropServiceTag,
  Effect.gen(function* () {
    const campaignService = yield* CampaignServiceTag;
    const api = yield* TwitchApiTag;
    const socket = yield* TwitchSocketTag;

    const dropChannel = (state: MainState) => resetChannel(state.currentChannel).pipe(Effect.provideService(TwitchSocketTag, socket));

    // Resolves one claim attempt; `true` means the sequence is finished, either
    // because the drop was claimed or because it can no longer be claimed.
    const attemptClaim = (campaign: Campaign, drop: Drop, attempt: number, state: MainState): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const currentDropInitial = yield* Ref.get(state.currentDrop);
        if (Option.isSome(currentDropInitial) && currentDropInitial.value.isClaimed) return true;

        if (Option.isNone(currentDropInitial) || !currentDropInitial.value.dropInstanceID) {
          yield* campaignService.updateProgress.pipe(Effect.ignore);
          const updatedDrop = yield* campaignService.findProgress(drop.id);

          if (Option.isSome(updatedDrop)) {
            const fresh = updatedDrop.value;
            yield* Ref.update(
              state.currentDrop,
              Option.map((cur) => ({
                ...fresh,
                currentMinutesWatched: Math.max(cur.currentMinutesWatched, fresh.currentMinutesWatched),
                dropInstanceID: fresh.dropInstanceID || cur.dropInstanceID,
              })),
            );
          }
        }

        const curDropOpt = yield* Ref.get(state.currentDrop);
        if (Option.isSome(curDropOpt)) {
          if (curDropOpt.value.isClaimed) return true;

          if (curDropOpt.value.dropInstanceID) {
            const claimRes = yield* api.claimDrops(curDropOpt.value.dropInstanceID).pipe(Effect.option);
            if (Option.isSome(claimRes) && claimRes.value.claimDropRewards) {
              yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Drops claimed}`);
              yield* campaignService.addRewards(drop.benefits.map((id) => ({ id, lastAwardedAt: new Date() })));
              yield* Ref.update(
                state.currentDrop,
                Option.map((d) => ({ ...d, isClaimed: true })),
              );
              return true;
            }
          }
        }

        const dropCheckOpt = yield* Ref.get(state.currentDrop);
        if (Option.isNone(dropCheckOpt)) return true;
        const dropCheck = dropCheckOpt.value;

        if (dropCheck.currentMinutesWatched < dropCheck.requiredMinutesWatched) {
          const isBroken = dropCheck.requiredMinutesWatched - dropCheck.currentMinutesWatched >= 20;
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {red ${isBroken ? 'Possible broken drops' : 'Minutes not met'}}`);
          if (isBroken) yield* campaignService.setBroken(dropCheck.campaignId, true);
          yield* Ref.set(state.currentDrop, Option.none());
          return true;
        }

        if (attempt === 0) yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found}`);
        yield* Effect.logInfo(chalk`{yellow Waiting for ${attempt + 1}/${MAX_CLAIM_ATTEMPTS} minutes for claim ID}`);

        if (attempt >= MAX_CLAIM_ATTEMPTS - 1) {
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found after ${MAX_CLAIM_ATTEMPTS} minutes}`);
          yield* campaignService.setBroken(campaign.id, true);
          yield* Ref.set(state.currentDrop, Option.none());
          return true;
        }

        yield* Effect.sleep('1 minute');
        return false;
      });

    return {
      claimDropSequence: (campaign, drop, state) =>
        Effect.acquireUseRelease(
          Ref.set(state.isClaiming, true),
          () =>
            Effect.iterate(
              { attempt: 0, isDone: false },
              {
                while: (s) => !s.isDone && s.attempt < MAX_CLAIM_ATTEMPTS,
                body: (s) => attemptClaim(campaign, drop, s.attempt, state).pipe(Effect.map((isDone) => ({ attempt: s.attempt + 1, isDone }))),
              },
            ),
          () => Ref.set(state.isClaiming, false),
        ).pipe(Effect.asVoid),

      syncDropProgress: (drop, state) =>
        Effect.gen(function* () {
          yield* Ref.set(state.localMinutesWatched, 0);
          yield* campaignService.updateProgress;

          const freshDrop = yield* campaignService.findProgress(drop.id);
          if (Option.isNone(freshDrop)) return;

          const desync = drop.currentMinutesWatched - freshDrop.value.currentMinutesWatched;
          if (desync >= 20) {
            yield* dropChannel(state);
          }

          yield* Ref.set(state.currentDrop, Option.some(freshDrop.value));
        }),
    } satisfies DropService;
  }),
);
