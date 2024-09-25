export function checkStatus(startAt: string, endAt: string, minutesLeft: number = 0) {
	const [currentDate, startDate, endDate, remainingDate] = [
		new Date(),
		new Date(startAt),
		new Date(endAt),
		new Date(Date.now() + (minutesLeft + 5) * 1000),
	]

	if (currentDate > startDate && currentDate < endDate && remainingDate < endDate) return 'active'
	else if (currentDate <= startDate) return 'upcoming'
	else return 'expired'
}
