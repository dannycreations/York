import { Queue } from './internal/Queue'

export class QueueStore<T extends object> extends Queue<T> {
	public state: 1 | 2 | 3 = 1
	public isWorking = false
	public isSleeping = false

	public override dequeue(): T | undefined {
		this.isWorking = false
		return super.dequeue()
	}
}
