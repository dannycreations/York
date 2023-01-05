import { Queue } from './Queue'

export class QueueStore<T> extends Queue<T> {
	private _isStage: StageContext = 1
	private _isTask: boolean = false
	private _isSleeping: boolean = false

	public isStage(stage?: StageContext): number {
		if (typeof stage === 'number') {
			this._isStage = stage
		}
		return this._isStage
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

type StageContext = 1 | 2 | 3
