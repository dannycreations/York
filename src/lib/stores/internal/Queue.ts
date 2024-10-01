export class Queue<V> {
	public get length() {
		return this.tailIdx - this.headIdx
	}

	public peek(i: number = 0): V | undefined {
		return this.elements[this.headIdx + i]
	}

	public last() {
		return this.lastState
	}

	public enqueue(element: V) {
		this.elements[this.tailIdx] = element
		this.tailIdx++
		return this
	}

	public enqueueMany(elements: V[]) {
		for (const element of elements) {
			this.enqueue(element)
		}
		return this
	}

	public dequeue(i: number = 0): V | undefined {
		const item = this.elements[this.headIdx + i]
		this.lastState = item
		this.elements[this.headIdx + i] = undefined
		this.headIdx++
		return item
	}

	public clear() {
		while (this.length) this.dequeue()
	}

	public values() {
		return Object.values(this.elements)
	}

	private headIdx = 0
	private tailIdx = 0
	private lastState: V
	private elements: Element<V> = {}
}

interface Element<V = {}> {
	[key: string]: V
}
