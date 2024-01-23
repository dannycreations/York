import { Piece } from '@sapphire/pieces'

export abstract class Task<O extends Task.Options = Task.Options> extends Piece<O> {
	public constructor(context: Task.Context, options: O = {} as O) {
		super(context, { ...options, name: (options.name ?? context.name).toUpperCase() })

		this.setDelay(options.delay)
	}

	public runOnInit?(): unknown
	public abstract run(...args: unknown[]): unknown

	public override onLoad(): unknown {
		this._run(true).then(() => this._loop())
		return super.onLoad()
	}

	public override onUnload(): unknown {
		this.stopTask()
		return super.onUnload()
	}

	public get isStatus() {
		return {
			idle: this._isIdle,
			stop: this._isStop,
			running: this._isRunning,
		}
	}

	public setDelay(delay: number): void {
		const maxDelay = 2147483647
		if (delay > maxDelay) delay = maxDelay

		this._delay = delay
	}

	public startTask(force?: boolean): void {
		this._isStop = false
		this._loop(force)
	}

	public stopTask(): void {
		this._isStop = true
	}

	public sleepUntil(f: () => boolean, ms: number = 20): Promise<void> {
		return new Promise((resolve) => {
			const wait = setInterval(() => {
				if (f()) {
					clearInterval(wait)
					resolve()
				}
			}, ms)
		})
	}

	private async _run(init?: boolean): Promise<void> {
		this.container.logger.trace(`Task Run: ${this.options.name}`)
		this._isRunning = true

		try {
			if (!init) {
				await this.run()
			} else if (this.runOnInit) {
				await this.runOnInit()
			}
		} catch (error) {
			this.container.logger.error(error, this.location.name)
		}

		this._isRunning = false
		this.container.logger.trace(`Task End: ${this.options.name}`)
	}

	private get _status(): boolean {
		if (this._isRunning) return true
		if (this._isStop) {
			delete this._timeout
			this._isStop = false
			return true
		}
	}

	private async _loop(force?: boolean): Promise<void> {
		clearTimeout(this._timeout)

		if (this._status) return
		if (force) await this._run()

		this._isIdle = true
		this._timeout = setTimeout(() => {
			this._isIdle = false
			if (this._status) return

			this._run().then(() => this._loop())
		}, this._delay)
	}

	private _delay: number = 0
	private _isIdle: boolean = false
	private _isStop: boolean = false
	private _isRunning: boolean = false
	private _timeout?: NodeJS.Timeout
}

export interface TaskOptions extends Piece.Options {
	readonly delay: number
}

export namespace Task {
	export type Options = TaskOptions
	export type Context = Piece.Context
}
