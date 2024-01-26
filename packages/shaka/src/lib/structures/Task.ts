import { Piece } from '@sapphire/pieces'
import { Result } from '@sapphire/result'

export abstract class Task<Options extends Task.Options = Task.Options> extends Piece<Options, 'tasks'> {
	public constructor(context: Task.LoaderContext, options: Options = {} as Options) {
		super(context, { ...options, name: (options.name ?? context.name).toUpperCase() })

		this.setDelay(options.delay)
	}

	public runOnInit?(): unknown
	public abstract run(...args: unknown[]): unknown

	public get isStatus() {
		return {
			idle: this._isIdle,
			stop: this._isStop,
			running: this._isRunning,
		}
	}

	public setDelay(delay: number) {
		const maxDelay = 2147483647
		if (delay > maxDelay) delay = maxDelay

		this._delay = delay
	}

	public startTask(force?: boolean) {
		this._isStop = false
		this._loop(force)
	}

	public stopTask() {
		this._isStop = true
	}

	private async _run(init?: boolean) {
		this.container.logger.trace(`Task Run: ${this.options.name}`)
		this._isRunning = true

		const result = await Result.fromAsync(async () => {
			if (!init) {
				await this.run()
			} else if (this.runOnInit) {
				await this.runOnInit()
			}
		})
		result.inspectErr((error) => this.container.logger.error(error, this.location.name))

		this._isRunning = false
		this.container.logger.trace(`Task End: ${this.options.name}`)
	}

	private get _status() {
		if (this._isRunning) return true
		if (this._isStop) {
			delete this._timeout
			this._isStop = false
			return true
		}
	}

	private async _loop(force?: boolean) {
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
	export type LoaderContext = Piece.LoaderContext<'tasks'>
}
