const GRACE_PERIOD_MINUTES: number = 10;

export function dropStatus(startAt: Date, endAt: Date, minutesLeft?: number): DropStatus {
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
    upcoming: isUpcoming,
    expired: isExpired,
  };
}

export interface DropStatus {
  expired: boolean;
  upcoming: boolean;
}
