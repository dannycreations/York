import { StoreRegistry, container } from '@sapphire/pieces'
import { parse } from 'jsonc-parser'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Logger } from 'pino'
import ws from 'ws'
import { TwitchGql } from './api/TwitchGql'
import { WebSocket } from './api/WebSocket'
import { ListenerStore } from './structures/ListenerStore'
import { TaskStore } from './structures/TaskStore'

export class YorkClient {
	public constructor() {
		container.config = {
			isClaimDrops: false,
			isClaimPoints: false,
			isDropPriorityOnly: true,
			usePriorityConnected: true,
			priorityList: [],
			exclusionList: [],
		}

		container.client = this
		container.ws = new WebSocket()
		container.twitch = new TwitchGql(process.env.AUTH_TOKEN_MOBILE)

		container.stores = new StoreRegistry()
		container.stores.register(new TaskStore().registerPath(join(__dirname, '..', 'tasks')))
		container.stores.register(new ListenerStore().registerPath(join(__dirname, '..', 'listeners')))
	}

	public async start() {
		try {
			const pathSettings = `${process.cwd()}/settings.json`
			if (existsSync(pathSettings)) {
				const config = parse(readFileSync(pathSettings, 'utf8'))
				Object.assign(container.config, config)
				Object.freeze(container.config)
			}

			await container.ws.connect()
			await Promise.all([...container.stores.values()].map((store) => store.loadAll()))
		} catch (error) {
			container.logger.fatal(error)
			process.exit()
		}
	}
}

declare module '@sapphire/pieces' {
	interface Container {
		ev: ws
		ws: WebSocket
		client: YorkClient
		logger: Logger
		twitch: TwitchGql
		config: {
			isClaimDrops: boolean
			isClaimPoints: boolean
			isDropPriorityOnly: boolean
			usePriorityConnected: boolean
			priorityList: string[]
			exclusionList: string[]
		}
	}

	interface StoreRegistryEntries {
		tasks: TaskStore
		listeners: ListenerStore
	}
}
