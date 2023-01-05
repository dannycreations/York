import { Queue } from './Queue'

export class QueueStore<T> extends Queue<T> {
	private _isTask: boolean = false
	private _isSleeping: boolean = false

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
