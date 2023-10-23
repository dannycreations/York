import { Piece } from '@sapphire/pieces'
import { EventEmitter } from 'node:events'
import { ListenerStore } from './ListenerStore'

export abstract class Listener<O extends Listener.Options = Listener.Options> extends Piece<O> {
	public declare store: ListenerStore
	public readonly emitter: EventEmitter | null
	public readonly event: string | symbol
	public readonly once: boolean
	private _listener: ((...args: any[]) => void) | null

	public constructor(context: Listener.Context, options: O = {} as O) {
		super(context, options)

		this.emitter =
			typeof options.emitter === 'undefined'
				? this.container.ev
				: (typeof options.emitter === 'string'
						? (Reflect.get(this.container.ev, options.emitter) as EventEmitter)
						: (options.emitter as EventEmitter)) ?? null
		this.event = options.event ?? this.name
		this.once = options.once ?? false

		this._listener = this.emitter && this.event ? (this.once ? this._runOnce.bind(this) : this._run.bind(this)) : null

		if (this.emitter === null || this._listener === null) this.enabled = false
	}

	public abstract run(...args: unknown[]): unknown

	public override onLoad(): unknown {
		if (this._listener) {
			const emitter = this.emitter!
			const maxListeners = emitter.getMaxListeners()
			if (maxListeners !== 0) emitter.setMaxListeners(maxListeners + 1)
			emitter[this.once ? 'once' : 'on'](this.event, this._listener)
		}
		return super.onLoad()
	}

	public override onUnload(): unknown {
		if (!this.once && this._listener) {
			const emitter = this.emitter!
			const maxListeners = emitter.getMaxListeners()
			if (maxListeners !== 0) emitter.setMaxListeners(maxListeners - 1)
			emitter.off(this.event, this._listener)
			this._listener = null
		}
		return super.onUnload()
	}

	private async _run(...args: unknown[]): Promise<void> {
		this.container.logger.trace(`Listener Run: ${this.options.event!.toString()}`)
		try {
			await this.run(...args)
		} catch (error) {
			this.container.logger.error(error, this.location.name)
		}
		this.container.logger.trace(`Listener End: ${this.options.event!.toString()}`)
	}

	private async _runOnce(...args: unknown[]): Promise<void> {
		await this._run(...args)
		await this.unload()
	}
}

export interface ListenerOptions extends Piece.Options {
	readonly emitter?: EventEmitter
	readonly event?: string | symbol
	readonly once?: boolean
}

export namespace Listener {
	export type Options = ListenerOptions
	export type Context = Piece.Context
}
