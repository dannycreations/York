import { EntityManager, EntityRepository, MikroORM } from '@mikro-orm/better-sqlite'
import { container, Vegapunk } from '@vegapunk/core'
import { parseJsonc } from '@vegapunk/utilities'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CampaignEntity } from './entities/campaign.entity'
import { ChannelEntity } from './entities/channel.entity'
import { DropEntity } from './entities/drop.entity'

export class YorkClient extends Vegapunk {
	public override config = {
		isClaimDrops: false,
		isClaimPoints: false,
		isDropPriorityOnly: true,
		usePriorityConnected: true,
		priorityList: [] as string[],
		exclusionList: [] as string[],
	}

	public override async start() {
		container.campaignRepository = container.em.getRepository(CampaignEntity)
		container.dropRepository = container.em.getRepository(DropEntity)
		container.channelRepository = container.em.getRepository(ChannelEntity)

		const pathSettings = join(process.cwd(), 'settings.json')
		if (existsSync(pathSettings)) {
			const config = parseJsonc(readFileSync(pathSettings, 'utf8'))
			Object.assign(this.config, config)
			Object.freeze(this.config)
		}

		await super.start()
	}
}

declare module '@vegapunk/core' {
	interface Container {
		// ! TODO: fixing types
		orm: MikroORM
		em: EntityManager
		// ====================

		campaignRepository: EntityRepository<CampaignEntity>
		dropRepository: EntityRepository<DropEntity>
		channelRepository: EntityRepository<ChannelEntity>
	}

	interface Vegapunk {
		readonly config: {
			isClaimDrops: boolean
			isClaimPoints: boolean
			isDropPriorityOnly: boolean
			usePriorityConnected: boolean
			priorityList: string[]
			exclusionList: string[]
		}
	}
}
