import { chalk } from '@vegapunk/utilities';
import { Context, Effect, Layer, Option, Ref } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi';
import { CampaignServiceTag } from './CampaignService';

import type { TwitchApiError } from '../api/TwitchApi';
import type { Campaign, Channel, Drop } from '../core/Schemas';

export interface DropService {
  readonly claimDropSequence: (
    campaign: Campaign,
    drop: Drop,
    isClaimingRef: Ref.Ref<boolean>,
    currentDropRef: Ref.Ref<Option.Option<Drop>>,
  ) => Effect.Effect<void>;
  readonly syncDropProgress: (
    drop: Drop,
    localMinutesWatchedRef: Ref.Ref<number>,
    currentDropRef: Ref.Ref<Option.Option<Drop>>,
    currentChannelRef: Ref.Ref<Option.Option<Channel>>,
  ) => Effect.Effect<void, TwitchApiError>;
}

export class DropServiceTag extends Context.Tag('@services/DropService')<DropServiceTag, DropService>() {}

export const DropServiceLayer = Layer.effect(
  DropServiceTag,
  Effect.gen(function* () {
    const campaignService = yield* CampaignServiceTag;
    const api = yield* TwitchApiTag;

    return {
      claimDropSequence: (campaign, drop, isClaimingRef, currentDropRef) =>
        Effect.acquireUseRelease(
          Ref.set(isClaimingRef, true),
          () =>
            Effect.iterate(0, {
              while: (attempt) => attempt < 5,
              body: (attempt) =>
                Effect.gen(function* () {
                  const currentDropInitial = yield* Ref.get(currentDropRef);
                  if (Option.isSome(currentDropInitial) && currentDropInitial.value.isClaimed) return 5;

                  if (attempt > 0 || !drop.dropInstanceID) {
                    yield* campaignService.updateProgress.pipe(Effect.orDie);
                    const drops = yield* campaignService.getDropsForCampaign(campaign.id).pipe(Effect.orDie);
                    const updatedDrop = drops.find((p) => p.id === drop.id);
                    if (updatedDrop) {
                      yield* Ref.update(currentDropRef, (current) =>
                        Option.map(current, (cur) => ({
                          ...updatedDrop,
                          currentMinutesWatched: Math.max(cur.currentMinutesWatched, updatedDrop.currentMinutesWatched),
                          dropInstanceID: updatedDrop.dropInstanceID || cur.dropInstanceID,
                        })),
                      );
                    }
                  }

                  const curDropOpt = yield* Ref.get(currentDropRef);
                  if (Option.isSome(curDropOpt)) {
                    if (curDropOpt.value.isClaimed) return 5;

                    if (!!curDropOpt.value.dropInstanceID) {
                      const claimRes = yield* api.claimDrops(curDropOpt.value.dropInstanceID).pipe(Effect.option, Effect.orDie);
                      if (Option.isSome(claimRes) && claimRes.value.claimDropRewards) {
                        yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Drops claimed}`);
                        yield* campaignService.addRewards(drop.benefits.map((id) => ({ id, lastAwardedAt: new Date() }))).pipe(Effect.orDie);
                        yield* Ref.update(
                          currentDropRef,
                          Option.map((d) => ({ ...d, isClaimed: true })),
                        );
                        return 5;
                      }
                    }
                  }

                  const dropCheckOpt = yield* Ref.get(currentDropRef);
                  if (Option.isNone(dropCheckOpt)) return 5;
                  const dropCheck = dropCheckOpt.value;

                  if (dropCheck.currentMinutesWatched < dropCheck.requiredMinutesWatched) {
                    const isBroken = dropCheck.requiredMinutesWatched - dropCheck.currentMinutesWatched >= 20;
                    yield* Effect.logInfo(chalk`{green ${drop.name}} | {red ${isBroken ? 'Possible broken drops' : 'Minutes not met'}}`);
                    if (isBroken) yield* campaignService.setBroken(dropCheck.campaignId, true);
                    yield* Ref.set(currentDropRef, Option.none());
                    return 5;
                  }

                  if (attempt === 0) yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found}`);
                  yield* Effect.logInfo(chalk`{yellow Waiting for ${attempt + 1}/5 minutes for claim ID}`);

                  if (attempt >= 4) {
                    yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found after 5 minutes}`);
                    yield* campaignService.setBroken(campaign.id, true);
                    yield* Ref.set(currentDropRef, Option.none());
                    return 5;
                  }

                  yield* Effect.sleep('1 minute');
                  return attempt + 1;
                }),
            }),
          () => Ref.set(isClaimingRef, false),
        ),

      syncDropProgress: (drop, localMinutesWatchedRef, currentDropRef, currentChannelRef) =>
        Effect.gen(function* () {
          yield* Ref.set(localMinutesWatchedRef, 0);
          yield* campaignService.updateProgress;

          const freshDrops = yield* campaignService.getDropsForCampaign(drop.campaignId);
          const freshDrop = freshDrops.find((d) => d.id === drop.id);
          if (!freshDrop) return;

          const desync = drop.currentMinutesWatched - freshDrop.currentMinutesWatched;
          if (desync >= 20) {
            yield* Ref.update(
              currentChannelRef,
              Option.map((ch) => ({ ...ch, isOnline: false })),
            );
          }

          yield* Ref.set(currentDropRef, Option.some(freshDrop));
        }),
    };
  }),
);
