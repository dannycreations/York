import { container, Vegapunk } from '@vegapunk/core'
import { parseJsonc } from '@vegapunk/utilities'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { TwitchGql } from './api/TwitchGql'
import { WSClient } from './api/WSClient'

export class YorkClient extends Vegapunk {
	public override config: YorkConfig = {
		isClaimDrops: false,
		isClaimPoints: false,
		isClaimMoments: false,
		isDropPriorityOnly: true,
		usePriorityConnected: true,
		priorityList: [],
		exclusionList: [],
	}

	public constructor() {
		super()

		if (!process.env.AUTH_TOKEN) {
			throw new Error('AUTH_TOKEN is required!')
		}

		container.ws = new WSClient(process.env.AUTH_TOKEN)
		container.api = new TwitchGql(process.env.AUTH_TOKEN)
	}

	public override async start(): Promise<void> {
		const settingPath = join(process.cwd(), 'sessions/settings.json')
		await access(settingPath).catch(() => mkdir(dirname(settingPath), { recursive: true }))
		await access(settingPath).catch(() => writeFile(settingPath, JSON.stringify(this.config, null, 2)))

		const config = parseJsonc<YorkConfig>(await readFile(settingPath, 'utf8'))
		Object.assign(this.config, config)

		await Promise.all([container.ws.connect(), container.api.init()])
		await super.start()
	}

	public async destroy(): Promise<void> {
		container.ws.destroy()
	}
}

interface YorkConfig {
	isClaimDrops: boolean
	isClaimPoints: boolean
	isClaimMoments: boolean
	isDropPriorityOnly: boolean
	usePriorityConnected: boolean
	priorityList: string[]
	exclusionList: string[]
}

declare module '@vegapunk/core' {
	interface Container {
		ws: WSClient
		api: TwitchGql
	}

	interface Vegapunk {
		readonly config: YorkConfig
	}
}
