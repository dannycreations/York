export function dropStatus(startAt: Date, endAt: Date, minutesLeft?: number): DropStatus {
	const [currentDate, startDate, endDate, remainingDate] = [
		new Date(),
		startAt,
		endAt,
		new Date(Date.now() + (minutesLeft ? 60_000 * (minutesLeft + 10) : 0)),
	]
	return {
		upcoming: currentDate < startDate && currentDate < endDate,
		expired: endDate < currentDate || endDate < remainingDate,
	}
}

export interface DropStatus {
	expired: boolean
	upcoming: boolean
}
