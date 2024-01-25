import { MikroORM as _orm } from '@mikro-orm/core'
import { container } from '@sapphire/pieces'
import { ormConfig } from './config/orm.config'
import { CampaignEntity } from './entities/campaign.entity'
import { ChannelEntity } from './entities/channel.entity'
import { DropEntity } from './entities/drop.entity'

export async function MikroORM() {
	container.orm = await _orm.init(ormConfig)
	container.em = container.orm.em
	container.campaignRepository = container.em.getRepository(CampaignEntity)
	container.dropRepository = container.em.getRepository(DropEntity)
	container.channelRepository = container.em.getRepository(ChannelEntity)

	const generator = container.orm.getSchemaGenerator()
	if (process.env.NODE_ENV === 'development') {
		await generator.dropSchema()
		await generator.createSchema()
	} else {
		await generator.ensureDatabase()
		await generator.updateSchema()
	}

	container.logger.info('MikroORM successfully connected.')
}
