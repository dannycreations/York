import { Queue } from '../database/Queue'

export class QueueStore<T> extends Queue<T> {
	public isState(state?: StateContext): number {
		if (typeof state === 'number') {
			this.queueState = state
		}
		return this.queueState
	}

	public hasTask(bool?: boolean): boolean {
		if (typeof bool === 'boolean') {
			this.taskState = bool
		}
		return this.taskState
	}

	public isSleeping(bool?: boolean): boolean {
		if (typeof bool === 'boolean') {
			this.sleepingState = bool
		}
		return this.sleepingState
	}

	private queueState: StateContext = 1
	private taskState: boolean = false
	private sleepingState: boolean = false
}

type StateContext = 1 | 2 | 3
