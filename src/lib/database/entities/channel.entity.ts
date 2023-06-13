import { CampaignEntity } from './campaign.entity'
import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'

@Entity({ tableName: 'channel' })
export class ChannelEntity {
	@PrimaryKey()
	id: number

	@Property()
	login: string

	@Property()
	channel_id: string

	@Property()
	broadcast_id: string

	@ManyToOne(() => CampaignEntity)
	campaign: CampaignEntity
}
