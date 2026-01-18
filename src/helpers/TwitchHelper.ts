export const GRACE_PERIOD_MINUTES = 10;

export const getDropStatus = (startAt: Date, endAt: Date, minutesLeft?: number): { readonly isUpcoming: boolean; readonly isExpired: boolean } => {
  const nowMs = Date.now();
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
