import { Option } from 'effect';

export const GRACE_PERIOD_MINUTES = 10;

export const getDropStatus = (
  startAt: Date,
  endAt: Date,
  nowMs: number,
  minutesLeft?: number,
): { readonly isUpcoming: boolean; readonly isExpired: boolean } => {
  const startAtMs = startAt.getTime();
  const endAtMs = endAt.getTime();

  let isExpired = endAtMs < nowMs;
  if (typeof minutesLeft === 'number') {
    const totalMinutesOffset = minutesLeft + GRACE_PERIOD_MINUTES;
    const deadlineFromMinutesLeftMs = nowMs + totalMinutesOffset * 60_000;
    isExpired = isExpired || endAtMs < deadlineFromMinutesLeftMs;
  }

  const isUpcoming = nowMs < startAtMs && nowMs < endAtMs;

  return {
    isUpcoming,
    isExpired,
  };
};

export const isMinutesWatchedMet = (drop: { readonly currentMinutesWatched: number; readonly requiredMinutesWatched: number }): boolean =>
  drop.currentMinutesWatched >= drop.requiredMinutesWatched + 1;

export const calculatePriority = (
  target: { readonly game: { readonly id: string }; readonly endAt: Date },
  currentCampaign: Option.Option<{ readonly priority: number; readonly game: { readonly id: string } }>,
  currentDrop: Option.Option<{ readonly endAt: Date }>,
): number => {
  if (Option.isNone(currentCampaign)) {
    return 0;
  }
  const current = currentCampaign.value;
  const isDifferentGame = current.game.id !== target.game.id;
  const shouldPrioritize = Option.isSome(currentDrop) && isDifferentGame && currentDrop.value.endAt >= target.endAt;

  return shouldPrioritize ? current.priority + 1 : 0;
};
