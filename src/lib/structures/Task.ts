import { Piece } from '@sapphire/pieces'

export abstract class Task<O extends Task.Options = Task.Options> extends Piece<O> {
	private delay: number = 0
	private isIdle: boolean = false
	private isStop: boolean = false
	private isRunning: boolean = false
	private timeout?: NodeJS.Timeout

	public constructor(context: Task.Context, options: O = {} as O) {
		super(context, { ...options, name: (options.name ?? context.name).toUpperCase() })

		this.setDelay(options.delay)
	}

	public runOnInit?(): unknown
	public abstract run(...args: unknown[]): unknown

	public override onLoad(): unknown {
		this._run(true).then(() => this.loop())
		return super.onLoad()
	}

	public override onUnload(): unknown {
		this.stopTask()
		return super.onUnload()
	}

	private async _run(init?: boolean): Promise<void> {
		this.container.logger.trace(`Task Run: ${this.options.name}`)
		this.isRunning = true
		try {
			if (!init) {
				await this.run()
			} else if (this.runOnInit) {
				await this.runOnInit()
			}
		} catch (error) {
			this.container.logger.error(error, this.location.name)
		}
		this.isRunning = false
		this.container.logger.trace(`Task End: ${this.options.name}`)
	}

	public isStatus() {
		return {
			idle: this.isIdle,
			stop: this.isStop,
			running: this.isRunning,
		}
	}

	public setDelay(delay: number): void {
		const maxDelay = 2147483647
		if (delay > maxDelay) delay = maxDelay

		this.delay = delay
	}

	public startTask(force?: boolean): void {
		this.isStop = false
		this.loop(force)
	}

	public stopTask(): void {
		this.isStop = true
	}

	protected sleepUntil(f: () => boolean, ms: number = 20): Promise<void> {
		return new Promise((resolve) => {
			const wait = setInterval(() => {
				if (f()) {
					clearInterval(wait)
					resolve()
				}
			}, ms)
		})
	}

	private async loop(force?: boolean): Promise<void> {
		clearTimeout(this.timeout)
		const operations = () => {
			if (this.isRunning) return true
			if (this.isStop) {
				delete this.timeout
				return true
			}
		}
		if (operations()) return
		if (force) await this._run()

		this.isIdle = true
		this.timeout = setTimeout(() => {
			this.isIdle = false
			if (operations()) return

			this._run().then(() => this.loop())
		}, this.delay)
	}
}

export interface TaskOptions extends Piece.Options {
	readonly delay: number
}

export namespace Task {
	export type Options = TaskOptions
	export type Context = Piece.Context
}
