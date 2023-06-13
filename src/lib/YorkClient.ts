import ws, { WebSocket } from 'ws'
import { Logger } from 'pino'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { TwitchGql } from './api/TwitchGql'
// import { WebSocket } from './api/WebSocket'
import { existsSync, readFileSync } from 'node:fs'
import { TaskStore } from './structures/TaskStore'
import { DropEntity } from './database/entities/drop.entity'
import { ListenerStore } from './structures/ListenerStore'
import { container, StoreRegistry } from '@sapphire/pieces'
import { ChannelEntity } from './database/entities/channel.entity'
import { CampaignEntity } from './database/entities/campaign.entity'
import { MikroORM, EntityManager, EntityRepository } from '@mikro-orm/core'

export class YorkClient {
	constructor() {
		container.config = {
			isClaimDrops: false,
			isClaimPoints: false,
			isDropPriorityOnly: true,
			usePriorityConnected: true,
			priorityList: [],
			exclusionList: [],
		}

		container.client = this
		// container.ws = new WebSocket()
		container.twitch = new TwitchGql(process.env.AUTH_TOKEN)

		container.stores = new StoreRegistry()
		container.stores.register(new TaskStore().registerPath(join(__dirname, '..', 'tasks')))
		container.stores.register(new ListenerStore().registerPath(join(__dirname, '..', 'listeners')))
	}

	async start(): Promise<void> {
		try {
			const pathSettings = `${process.cwd()}/settings.json`
			if (existsSync(pathSettings)) {
				const config = parse(readFileSync(pathSettings, 'utf8'))
				Object.assign(container.config, config)
				Object.freeze(container.config)
			}

			// await container.ws.connect()
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

		orm: MikroORM
		em: EntityManager
		campaignRepository: EntityRepository<CampaignEntity>
		dropRepository: EntityRepository<DropEntity>
		channelRepository: EntityRepository<ChannelEntity>
	}

	interface StoreRegistryEntries {
		tasks: TaskStore
		listeners: ListenerStore
	}
}
