import { Queue } from './Queue'
import { container } from '@sapphire/pieces'
import { ActiveTimeBasedDrop, checkStatus, Status } from '../resolvers/Campaign'

export class DropStore extends Queue<ActiveTimeBasedDrop> {
	public get id(): string {
		return super.peek()!.id
	}

	public get name(): string {
		return super.peek()!.benefitEdges[0].benefit.name
	}

	public get preconditionID(): string | undefined {
		return super.peek()!.preconditionDrops?.[0].id
	}

	public get dropInstanceID(): string | null | undefined {
		return super.peek()?.self.dropInstanceID
	}

	public get currentMinutesWatched(): number {
		return super.peek()!.self.currentMinutesWatched
	}

	public get requiredMinutesWatched(): number {
		return super.peek()!.requiredMinutesWatched
	}

	public isStatus(): Status {
		return checkStatus(super.peek()!.startAt, super.peek()!.endAt)
	}

	public hasPreconditionsMet(): boolean | undefined {
		return super.peek()?.self.hasPreconditionsMet
	}

	public hasMinutesWatchedMet(): boolean {
		if (!super.peek()?.self) return false
		return super.peek()!.self.currentMinutesWatched >= super.peek()!.requiredMinutesWatched
	}

	public setMinutesWatched(inc: number = 1): void {
		super.peek()!.self.currentMinutesWatched += inc
	}

	public setNextPreconditions(): void {
		if (!this.peek(1)) return
		this.peek(1)!.self.hasPreconditionsMet = true
	}

	/**
	 * ! TODO: Bypass integrity check
	 * @see {@link TwitchApi#integrity}
	 * @see {@link TwitchGql#useMobileAuth}
	 */
	public async claimDrops(): Promise<boolean> {
		if (!this.dropInstanceID) return false

		await container.twitch.claimDrops(this.dropInstanceID)
		return true
	}
}
