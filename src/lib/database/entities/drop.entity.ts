import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core'
import { CampaignEntity } from './campaign.entity'

@Entity({ tableName: 'drop' })
export class DropEntity {
	@PrimaryKey({ autoincrement: false })
	id: string

	@Property()
	name: string

	@Property({ nullable: true })
	dropInstanceId?: string

	@Property({ nullable: true })
	preconditionId?: string

	@Property({ type: 'boolean' })
	hasPreconditionsMet?: boolean

	@Property()
	currentMinutesWatched: number

	@Property()
	requiredMinutesWatched: number

	@Property({ type: Date })
	startAt: string

	@Property({ type: Date })
	endAt: string

	@ManyToOne(() => CampaignEntity)
	campaignId: CampaignEntity
}
