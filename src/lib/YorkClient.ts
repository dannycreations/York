import { Logger } from 'pino'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { logger } from './utils/logger'
import { TwitchGql } from './api/TwitchGql'
import { existsSync, readFileSync } from 'node:fs'
import { TaskStore } from './structures/TaskStore'
import { container, StoreRegistry } from '@sapphire/pieces'

export class YorkClient {
	public constructor() {
		container.config = {
			isClaimDrops: false,
			isClaimPoints: false,
			isDropPriorityOnly: false,
			isDropConnectedOnly: true,
			priorityList: [],
			exclusionList: []
		}

		container.client = this
		container.logger = logger()
		container.twitch = new TwitchGql(process.env.AUTH_TOKEN)

		container.stores = new StoreRegistry()
		container.stores.register(new TaskStore().registerPath(join(__dirname, '..', 'tasks')))
	}

	public async start(): Promise<void> {
		try {
			const pathSettings = `${process.cwd()}/settings.json`
			if (existsSync(pathSettings)) {
				const config = parse(readFileSync(pathSettings, 'utf8'))
				Object.assign(container.config, config)
				Object.freeze(container.config)
			}

			await Promise.all([...container.stores.values()].map((store) => store.loadAll()))
		} catch (error) {
			container.logger.fatal(error)
			process.exit()
		}
	}
}

declare module '@sapphire/pieces' {
	interface Container {
		client: YorkClient
		logger: Logger
		twitch: TwitchGql
		config: {
			isClaimDrops: boolean
			isClaimPoints: boolean
			isDropPriorityOnly: boolean
			isDropConnectedOnly: boolean
			priorityList: string[]
			exclusionList: string[]
		}
	}

	interface StoreRegistryEntries {
		tasks: TaskStore
	}
}
