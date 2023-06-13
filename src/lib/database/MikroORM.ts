import { container } from '@sapphire/pieces'
import { ormConfig } from './config/orm.config'
import { MikroORM as _orm } from '@mikro-orm/core'
import { DropEntity } from './entities/drop.entity'
import { ChannelEntity } from './entities/channel.entity'
import { CampaignEntity } from './entities/campaign.entity'

export async function MikroORM() {
	container.orm = await _orm.init(ormConfig)
	container.em = container.orm.em
	container.campaignRepository = container.orm.em.getRepository(CampaignEntity)
	container.dropRepository = container.orm.em.getRepository(DropEntity)
	container.channelRepository = container.orm.em.getRepository(ChannelEntity)

	const generator = container.orm.getSchemaGenerator()
	await generator.dropSchema()
	await generator.createSchema()

	container.logger.info('MikroORM successfully connected')
}
