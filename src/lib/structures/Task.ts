import { Piece } from '@sapphire/pieces'

export abstract class Task<O extends Task.Options = Task.Options> extends Piece<O> {
	private _delay: number = 6e5
	private _idle: boolean = false
	private _stop: boolean = false
	private _running: boolean = false
	private _timeout?: NodeJS.Timeout

	public constructor(context: Task.Context, options: O = {} as O) {
		super(context, { ...options, name: (options.name ?? context.name).toUpperCase() })

		this.setDelay(options.delay)
	}

	public runOnInit?(): unknown
	public abstract run(...args: unknown[]): unknown

	public override onLoad(): unknown {
		this._run.call(this, true).then(this.loop.bind(this))
		return super.onLoad()
	}

	public override onUnload(): unknown {
		this.stopTask()
		return super.onUnload()
	}

	private async _run(init?: boolean): Promise<void> {
		try {
			if (!init) {
				await this.run()
			} else if (this.runOnInit) {
				await this.runOnInit()
			}
		} catch (error) {
			this.container.logger.error(error, this.location.name)
		}
	}

	public isStatus() {
		return {
			idle: () => this._idle,
			stop: () => this._stop,
			running: () => this._running
		}
	}

	public setDelay(delay: number): void {
		const maxDelay = 2147483647
		if (delay > maxDelay) delay = maxDelay

		this._delay = delay
	}

	public startTask(): Promise<void> {
		this._stop = false
		return this._run.call(this).then(this.loop.bind(this))
	}

	public stopTask(): void {
		this._stop = true
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
		clearTimeout(this._timeout)
		const operations = () => {
			if (this._running) {
				this._running = false
				return true
			}
			if (this._stop) {
				delete this._timeout
				return true
			}
		}

		if (operations()) return

		this._idle = true
		this._timeout = setTimeout(async () => {
			this._idle = false
			if (operations()) return

			this._running = true
			await this._run()
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
