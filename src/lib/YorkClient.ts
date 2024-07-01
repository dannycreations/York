import { ListenerStore, TaskStore, Vegapunk, container } from '@vegapunk/core'
import { parseJsonc } from '@vegapunk/utilities'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ws from 'ws'
import { TwitchGql } from './api/TwitchGql'
import { WebSocket } from './api/WebSocket'

export class YorkClient extends Vegapunk {
	public readonly config = {
		isClaimDrops: false,
		isClaimPoints: false,
		isDropPriorityOnly: true,
		usePriorityConnected: true,
		priorityList: [],
		exclusionList: [],
	}

	public constructor() {
		super()
		container.ws = new WebSocket()
		container.twitch = new TwitchGql(process.env.AUTH_TOKEN)

		this.stores.register(new TaskStore().registerPath(join(__dirname, '..', 'tasks')))
		this.stores.register(new ListenerStore().registerPath(join(__dirname, '..', 'listeners')))
	}

	public async start() {
		try {
			const pathSettings = join(process.cwd(), 'settings.json')
			if (existsSync(pathSettings)) {
				const config = parseJsonc(readFileSync(pathSettings, 'utf8'))
				Object.assign(this.config, config)
				Object.freeze(this.config)
			}

			await container.ws.connect()
			await super.start()
		} catch (error) {
			container.logger.fatal(error)
			process.exit()
		}
	}
}

declare module '@vegapunk/core' {
	interface Container {
		ev: ws
		ws: WebSocket
		twitch: TwitchGql
	}

	interface Vegapunk {
		config: {
			isClaimDrops: boolean
			isClaimPoints: boolean
			isDropPriorityOnly: boolean
			usePriorityConnected: boolean
			priorityList: string[]
			exclusionList: string[]
		}
	}
}
