import { DropEntity } from './drop.entity'
import { ChannelEntity } from './channel.entity'
import { Entity, OneToMany, PrimaryKey, Property } from '@mikro-orm/core'

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

	@OneToMany(() => DropEntity, (r) => r.campaign)
	drops: DropEntity[]

	@OneToMany(() => ChannelEntity, (r) => r.campaign)
	channels: ChannelEntity[]
}
