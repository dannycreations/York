import { Option } from 'effect';

const GRACE_PERIOD_MINUTES = 10;

interface DropStatusInfo {
  readonly isUpcoming: boolean;
  readonly isExpired: boolean;
}

export const getDropStatus = (startAt: Date, endAt: Date, nowMs: number, minutesLeft?: number): DropStatusInfo => {
  const startAtMs = startAt.getTime();
  const endAtMs = endAt.getTime();

  const isTimeExpired = endAtMs < nowMs;

  const isMinutesExpired = typeof minutesLeft === 'number' && endAtMs < nowMs + (minutesLeft + GRACE_PERIOD_MINUTES) * 60_000;

  return {
    isUpcoming: nowMs < startAtMs && nowMs < endAtMs,
    isExpired: isTimeExpired || isMinutesExpired,
  };
};

export const isMinutesWatchedMet = (drop: { readonly currentMinutesWatched: number; readonly requiredMinutesWatched: number }): boolean =>
  drop.currentMinutesWatched >= drop.requiredMinutesWatched;

export const calculatePriority = (
  target: {
    readonly game: { readonly id: string } | null;
    readonly endAt: Date;
  },
  currentCampaign: Option.Option<{ readonly priority: number; readonly game: { readonly id: string } | null }>,
  currentDrop: Option.Option<{ readonly endAt: Date }>,
): number => {
  if (Option.isNone(currentCampaign) || Option.isNone(currentDrop)) {
    return 0;
  }

  const current = currentCampaign.value;
  if (current.game === null || target.game === null || current.game.id === target.game.id) {
    return 0;
  }

  if (currentDrop.value.endAt < target.endAt) {
    return 0;
  }

  return current.priority + 1;
};
