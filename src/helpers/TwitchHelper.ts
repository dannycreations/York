import { Option } from 'effect';

export const GRACE_PERIOD_MINUTES = 10;

export interface DropStatusInfo {
  readonly isUpcoming: boolean;
  readonly isExpired: boolean;
}

export const getDropStatus = (startAt: Date, endAt: Date, nowMs: number, minutesLeft?: number): DropStatusInfo => {
  const startAtMs = startAt.getTime();
  const endAtMs = endAt.getTime();

  const isTimeExpired = endAtMs < nowMs;

  const isMinutesExpired = typeof minutesLeft === 'number' && endAtMs < nowMs + (minutesLeft + GRACE_PERIOD_MINUTES) * 60_000;

  const isExpired = isTimeExpired || isMinutesExpired;
  const isUpcoming = nowMs < startAtMs && nowMs < endAtMs;

  return {
    isUpcoming,
    isExpired,
  };
};

export const isMinutesWatchedMet = (drop: { readonly currentMinutesWatched: number; readonly requiredMinutesWatched: number }): boolean =>
  drop.currentMinutesWatched >= drop.requiredMinutesWatched;

export const calculatePriority = (
  target: { readonly game: { readonly id: string }; readonly endAt: Date },
  currentCampaign: Option.Option<{
    readonly priority: number;
    readonly game: { readonly id: string };
  }>,
  currentDrop: Option.Option<{ readonly endAt: Date }>,
): number => {
  if (Option.isNone(currentCampaign)) {
    return 0;
  }

  if (Option.isNone(currentDrop)) {
    return 0;
  }

  const current = currentCampaign.value;
  const isSameGame = current.game.id === target.game.id;

  if (isSameGame) {
    return 0;
  }

  const currentDropValue = currentDrop.value;
  const isCurrentEndingSooner = currentDropValue.endAt < target.endAt;

  if (isCurrentEndingSooner) {
    return 0;
  }

  return current.priority + 1;
};
