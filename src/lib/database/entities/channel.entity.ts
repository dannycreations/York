import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { CampaignEntity } from './campaign.entity'

@Entity({ tableName: 'channel' })
export class ChannelEntity {
	@PrimaryKey()
	id: number

	@Property()
	login: string

	@Property()
	channelId: string

	@Property()
	broadcastId: string

	@ManyToOne(() => CampaignEntity)
	campaignId: CampaignEntity
}
