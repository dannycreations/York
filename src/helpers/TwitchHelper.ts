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

  const isTimeExpired = endAtMs < nowMs;
  const isMinutesExpired = typeof minutesLeft === 'number' ? endAtMs < nowMs + (minutesLeft + GRACE_PERIOD_MINUTES) * 60_000 : false;

  const isExpired = isTimeExpired || isMinutesExpired;
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
): number =>
  Option.match(currentCampaign, {
    onNone: () => 0,
    onSome: (current) => {
      const isDifferentGame = current.game.id !== target.game.id;
      const shouldPrioritize = Option.isSome(currentDrop) && isDifferentGame && currentDrop.value.endAt >= target.endAt;

      return shouldPrioritize ? current.priority + 1 : 0;
    },
  });
