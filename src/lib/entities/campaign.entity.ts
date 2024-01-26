import { Entity, OneToMany, PrimaryKey, Property } from '@mikro-orm/better-sqlite'
import { ChannelEntity } from './channel.entity'
import { DropEntity } from './drop.entity'

@Entity({ tableName: 'campaign' })
export class CampaignEntity {
	@PrimaryKey({ autoincrement: false })
	id: string

	@Property()
	name: string

	@Property()
	game: string

	@Property({ type: Date })
	startAt: string

	@Property({ type: Date })
	endAt: string

	@OneToMany(() => DropEntity, (r) => r.campaignId)
	drops: DropEntity[]

	@OneToMany(() => ChannelEntity, (r) => r.campaignId)
	channels: ChannelEntity[]
}
