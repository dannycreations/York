import { ListenerStore, ShakaClient, TaskStore, container } from '@dnycts/shaka'
import { parseJson } from '@dnycts/utilities'
import { EntityRepository } from '@mikro-orm/better-sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CampaignEntity } from './entities/campaign.entity'
import { ChannelEntity } from './entities/channel.entity'
import { DropEntity } from './entities/drop.entity'

export class YorkClient extends ShakaClient {
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
		container.campaignRepository = container.em.getRepository(CampaignEntity)
		container.dropRepository = container.em.getRepository(DropEntity)
		container.channelRepository = container.em.getRepository(ChannelEntity)

		this.stores.register(new TaskStore().registerPath(join(__dirname, '..', 'tasks')))
		this.stores.register(new ListenerStore().registerPath(join(__dirname, '..', 'listeners')))
	}

	public async start() {
		const pathSettings = join(process.cwd(), 'settings.json')
		if (existsSync(pathSettings)) {
			const config = parseJson(readFileSync(pathSettings, 'utf8'))
			Object.assign(this.config, config)
			Object.freeze(this.config)
		}

		await super.start()
	}
}

declare module '@dnycts/shaka' {
	interface ShakaClient {
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

declare module '@sapphire/pieces' {
	interface Container {
		campaignRepository: EntityRepository<CampaignEntity>
		dropRepository: EntityRepository<DropEntity>
		channelRepository: EntityRepository<ChannelEntity>
	}
}
