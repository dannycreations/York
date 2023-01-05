import { Piece } from '@sapphire/pieces'

export abstract class Task<O extends Task.Options = Task.Options> extends Piece<O> {
	private _delay: number
	private _idle: boolean = false
	private _pause: boolean = false
	private _running: boolean = false
	private _timeout?: NodeJS.Timeout
	private _task: () => Promise<void>

	public constructor(context: Task.Context, options: O = {} as O) {
		super(context, { ...options, name: (options.name ?? context.name).toUpperCase() })

		this._delay = options.delay
		this._task = this._run.bind(this)
	}

	public runOnInit?(): unknown
	public abstract run(...args: unknown[]): unknown

	public override async onLoad(): Promise<unknown> {
		await (this.runOnInit ??= () => true).call(this)
		this.loop()

		return super.onLoad()
	}

	private async _run(): Promise<void> {
		try {
			await this.run()
		} catch (error) {
			this.container.logger.error({ error, piece: this })
		}
	}

	public isStatus() {
		return {
			idle: () => this._idle,
			pause: () => this._pause,
			running: () => this._running
		}
	}

	public setDelay(delay: number): void {
		this._delay = delay
	}

	public async startTask(force?: boolean): Promise<void> {
		this._pause = false
		if (force) await this._task()
		this.loop()
	}

	public pauseTask(): void {
		this._pause = true
	}

	public sleepUntil(f: () => boolean, sleep: number = 20): Promise<boolean> {
		return new Promise((resolve) => {
			const wait = setInterval(() => {
				if (f()) {
					clearInterval(wait)
					resolve(true)
				}
			}, sleep)
		})
	}

	private loop(): void {
		const maxDelay = 2147483647
		if (this._delay > maxDelay) this._delay = maxDelay

		clearTimeout(this._timeout)
		const operations = () => {
			if (this._running) return true
			if (this._pause) return true
		}

		if (operations()) return
		this._idle = true
		this._timeout = setTimeout(async () => {
			this._idle = false
			if (operations()) return

			this._running = true
			await this._task()
			this._running = false

			this.loop()
		}, this._delay)
	}
}

export interface TaskOptions extends Piece.Options {
	delay: number
	name?: string
}

export namespace Task {
	export type Options = TaskOptions
	export type Context = Piece.Context
}
