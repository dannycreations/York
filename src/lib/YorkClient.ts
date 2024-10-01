import { Vegapunk, container } from '@vegapunk/core'
import { parseJsonc } from '@vegapunk/utilities'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TwitchGql } from './api/TwitchGql'
import { WebSocket } from './api/WebSocket'

export class YorkClient extends Vegapunk {
	public override config: YorkConfig = {
		isClaimDrops: false,
		isClaimPoints: false,
		isDropPriorityOnly: true,
		usePriorityConnected: true,
		priorityList: [],
		exclusionList: [],
	}

	public constructor() {
		super()
		container.ws = new WebSocket(process.env.AUTH_TOKEN)
		container.twitch = new TwitchGql(process.env.AUTH_TOKEN)
	}

	public override async start() {
		const pathSettings = join(process.cwd(), 'sessions/settings.json')
		await access(pathSettings).catch(() => mkdir(dirname(pathSettings), { recursive: true }))
		await access(pathSettings).catch(() => writeFile(pathSettings, JSON.stringify(this.config)))

		const config = parseJsonc<YorkConfig>(await readFile(pathSettings, 'utf8'))
		Object.assign(this.config, config)

		await container.ws.connect()
		await super.start()
	}
}

interface YorkConfig {
	isClaimDrops: boolean
	isClaimPoints: boolean
	isDropPriorityOnly: boolean
	usePriorityConnected: boolean
	priorityList: string[]
	exclusionList: string[]
}

declare module '@vegapunk/core' {
	interface Container {
		ws: WebSocket
		twitch: TwitchGql
	}

	interface Vegapunk {
		readonly config: YorkConfig
	}
}
