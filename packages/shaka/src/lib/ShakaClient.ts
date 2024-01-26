import { logger } from '@dnycts/logger'
import { Store, StoreRegistry, container } from '@sapphire/pieces'
import { Result } from '@sapphire/result'
import { EventEmitter } from 'node:events'
import { Logger } from 'pino'
import { ListenerStore } from './structures/ListenerStore'
import { TaskStore } from './structures/TaskStore'

export class ShakaClient extends EventEmitter {
	public logger: Logger
	public stores: StoreRegistry

	public constructor() {
		super()
		container.client = this

		if (!container.logger) container.logger = this.logger ?? logger()
		if (!this.logger) this.logger = container.logger

		if (this.logger.level === 'trace') {
			Store.logger = this.logger.trace.bind(this.logger)
		}

		this.stores = container.stores
		this.stores.register(new ListenerStore())
		this.stores.register(new TaskStore())
	}

	public async start() {
		const result = await Result.fromAsync(async () => {
			await Promise.all([...this.stores.values()].map((store) => store.loadAll()))
		})
		result.inspectErr((error) => this.logger.error(error))
	}
}

declare module '@sapphire/pieces' {
	interface Container {
		logger: Logger
		client: ShakaClient
	}

	interface StoreRegistryEntries {
		listeners: ListenerStore
		tasks: TaskStore
	}
}
