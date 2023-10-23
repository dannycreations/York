import { Queue } from '../database/Queue'

export class QueueStore<T> extends Queue<T> {
	private _isState: StateContext = 1
	private _isTask: boolean = false
	private _isSleeping: boolean = false
	private _taskMap = new Map<string, boolean | null>()

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

	public isDone(id: string, status?: boolean): boolean {
		const isTask = this._taskMap.get(id)
		this._taskMap.set(id, status)
		if (isTask === true) {
			this._taskMap.delete(id)
			return true
		}
		return false
	}
}

type StateContext = 1 | 2 | 3
