export class Queue<V> {
	private _elements: Element<V> = {}
	private _head = 0
	private _tail = 0
	private _last: V

	public get length(): number {
		return this._tail - this._head
	}

	public peek(i: number = 0): V | undefined {
		return this._elements[this._head + i]
	}

	public last(): V {
		return this._last
	}

	public enqueue(element: V): this {
		this._elements[this._tail] = element
		this._tail++
		return this
	}

	public enqueueMany(elements: V[]): this {
		for (const element of elements) {
			this.enqueue(element)
		}
		return this
	}

	public dequeue(i: number = 0): V | undefined {
		const item = this._elements[this._head + i]
		this._last = item
		delete this._elements[this._head + i]
		this._head++
		return item
	}

	public clear(): void {
		while (this.length) this.dequeue()
	}

	public values(): V[] {
		return Object.values(this._elements)
	}
}

interface Element<V = {}> {
	[key: string]: V
}
