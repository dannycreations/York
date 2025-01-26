import { isObjectLike } from '@vegapunk/utilities/common'

export class Queue<T> {
	public get length(): number {
		return this.#elements.length
	}

	public get highest(): number {
		return this.highestPriority
	}

	public get last(): T | undefined {
		return this.lastElement
	}

	public peek(i = 0): T | undefined {
		return this.#elements[i]?.value
	}

	public enqueue(value: T, priority = 0): void {
		priority = Math.max(priority, 0)
		this.#elements.push({ value, priority })

		this.heapifyUp(this.length - 1)
		if (priority > this.highestPriority) {
			this.highestPriority = priority
		}
	}

	public enqueueMany(elements: T[]): void {
		elements.forEach((r) => this.enqueue(r))
	}

	public dequeue(): T | undefined {
		const element = this.#elements.shift()
		if (!element) return undefined

		this.heapifyDown(0)
		this.updateHighestPriority()
		this.lastElement = element.value
		return element.value
	}

	public clear(): void {
		this.#elements.length = 0
		this.highestPriority = 0
	}

	public find(predicate: (val: T) => boolean): T | undefined {
		return this.#elements.find((r) => predicate(r.value))?.value
	}

	public upsert(predicate: (val: T) => boolean, val: T): void {
		const index = this.#elements.findIndex((r) => predicate(r.value))
		if (!~index) return this.enqueue(val)

		const element = this.#elements[index]
		if (isObjectLike(element.value)) {
			Object.assign(element.value, val)
		} else {
			element.value = val
		}
	}

	public priority(predicate: (val: T) => boolean, priority = 0): T | undefined {
		const index = this.#elements.findIndex((r) => predicate(r.value))
		if (!~index) return undefined

		const element = this.#elements[index]
		element.priority = Math.max(priority, 0)

		this.heapifyUp(index)
		this.heapifyDown(index)
		this.updateHighestPriority()
		return element.value
	}

	public delete(predicate: (val: T) => boolean): T | undefined {
		const index = this.#elements.findIndex((r) => predicate(r.value))
		if (!~index) return undefined

		const element = this.#elements.splice(index, 1)[0]

		this.heapifyUp(index)
		this.heapifyDown(index)
		this.updateHighestPriority()
		return element.value
	}

	private heapifyUp(index: number) {
		while (index > 0) {
			const parentIndex = Math.floor((index - 1) / 2)
			if (this.#elements[index].priority > this.#elements[parentIndex].priority) {
				this.swap(index, parentIndex)
				index = parentIndex
			} else break
		}
	}

	private heapifyDown(index: number) {
		while (index < this.length) {
			let highestIndex = index
			const leftChildIndex = 2 * index + 1
			const rightChildIndex = 2 * index + 2

			if (leftChildIndex < this.length && this.#elements[leftChildIndex].priority > this.#elements[highestIndex].priority) {
				highestIndex = leftChildIndex
			}

			if (rightChildIndex < this.length && this.#elements[rightChildIndex].priority > this.#elements[highestIndex].priority) {
				highestIndex = rightChildIndex
			}

			if (highestIndex !== index) {
				this.swap(index, highestIndex)
				index = highestIndex
			} else break
		}
	}

	private swap(i: number, j: number) {
		;[this.#elements[i], this.#elements[j]] = [this.#elements[j], this.#elements[i]]
	}

	private updateHighestPriority() {
		this.highestPriority = this.#elements.reduce((max, el) => Math.max(max, el.priority), 0)
	}

	private lastElement?: T
	private highestPriority = 0
	readonly #elements: Array<{ value: T; priority: number }> = []
}
