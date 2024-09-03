import { container } from '@vegapunk/core'
import { Queue } from '../database/Queue'
import { ActiveTimeBasedDrop, checkStatus } from '../resolvers/Campaign'

export class DropStore extends Queue<ActiveTimeBasedDrop> {
	public get id() {
		return super.peek()?.id
	}

	public get name() {
		return super.peek()?.benefitEdges[0].benefit.name
	}

	public get preconditionID(): string | null {
		return super.peek()?.preconditionDrops?.[0].id ?? null
	}

	public get dropInstanceID(): string | null {
		return super.peek()?.self?.dropInstanceID ?? null
	}

	public get currentMinutesWatched() {
		return super.peek()?.self?.currentMinutesWatched ?? 0
	}

	public get requiredMinutesWatched() {
		return super.peek()?.requiredMinutesWatched ?? 0
	}

	public isStatus() {
		const selectDrop = super.peek()
		const minutesLeft = selectDrop?.requiredMinutesWatched - selectDrop?.self?.currentMinutesWatched
		return checkStatus(selectDrop?.startAt, selectDrop?.endAt, minutesLeft)
	}

	public hasPreconditionsMet() {
		return super.peek()?.self?.hasPreconditionsMet ?? false
	}

	public hasMinutesWatchedMet() {
		const selectDrop = super.peek()
		if (!selectDrop || !('self' in selectDrop)) return false
		return selectDrop.self.currentMinutesWatched >= selectDrop.requiredMinutesWatched + 1
	}

	public setMinutesWatched(inc: number = 1) {
		const selectDrop = this.peek()
		if (selectDrop && 'self' in selectDrop) selectDrop.self.currentMinutesWatched += inc
	}

	public setNextPreconditions() {
		const selectDrop = this.peek(1)
		if (selectDrop && 'self' in selectDrop) selectDrop.self.hasPreconditionsMet = true
	}

	public async claimDrops() {
		if (!this.dropInstanceID) return false

		const res = await container.twitch.claimDrops(this.dropInstanceID)
		return 'claimDropRewards' in res.data
	}
}
