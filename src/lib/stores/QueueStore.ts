import { Queue } from './Queue'

export class QueueStore<T> extends Queue<T> {
	private _isState: StateContext = 1
	private _isTask: boolean = false
	private _isSleeping: boolean = false

	public isState(state?: StateContext): number {
		if (typeof state === 'number') {
			this._isState = state
		}
		return this._isState
	}

	public isTask(bool?: boolean): boolean {
		if (typeof bool === 'boolean') {
			this._isTask = bool
		}
		return this._isTask
	}

	public isSleeping(bool?: boolean): boolean {
		if (typeof bool === 'boolean') {
			this._isSleeping = bool
		}
		return this._isSleeping
	}
}

type StateContext = 1 | 2 | 3
