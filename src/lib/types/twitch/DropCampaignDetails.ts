import { Status } from '../Enum'

export interface DropCampaignDetails {
	user: User
}

export interface User {
	id: string
	dropCampaign: DropCampaign
}

export interface DropCampaign {
	id: string
	self: Self
	allow: Allow
	accountLinkURL: string
	description: string
	detailsURL: string
	endAt: string
	eventBasedDrops: unknown[]
	game: Game
	imageURL: string
	name: string
	owner: Omit<Game, 'displayName'>
	startAt: string
	status: Status
	timeBasedDrops: TimeBasedDrop[]
}

export interface Allow {
	channels: Game[] | null
	isEnabled: boolean
}

export interface Game {
	id: string
	name: string
	displayName: string
}

export interface Self {
	isAccountConnected: boolean
}

export interface TimeBasedDrop {
	id: string
	benefitEdges: BenefitEdge[]
	endAt: string
	name: string
	preconditionDrops: PreconditionDrop[] | null
	requiredMinutesWatched: number
	startAt: string
}

export interface BenefitEdge {
	benefit: Benefit
	entitlementLimit: number
}

export interface Benefit {
	id: string
	createdAt: string
	entitlementLimit: number
	game: Omit<Game, 'displayName'>
	imageAssetURL: string
	isIosAvailable: boolean
	name: string
	ownerOrganization: Omit<Game, 'displayName'>
}

export interface PreconditionDrop {
	id: string
}
