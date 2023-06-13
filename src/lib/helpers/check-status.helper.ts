export function checkStatus(startAt: string, endAt: string) {
	let [active, expired, upcoming] = new Array(3).fill(false) as boolean[]
	const [currentDate, startDate, endDate] = [new Date(), new Date(startAt), new Date(endAt)]
	if (currentDate > startDate && currentDate < endDate) active = true
	else if (currentDate <= startDate) upcoming = true
	else expired = true

	return { active, expired, upcoming }
}
