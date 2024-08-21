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
	eventBasedDrops: any[]
	game: Game
	imageURL: string
	name: string
	owner: Game
	startAt: string
	status: string
	timeBasedDrops: TimeBasedDrop[]
}

export interface Allow {
	channels: Game[] | null
	isEnabled: boolean
}

export interface Game {
	id: string
	displayName?: string
	name?: string
	slug?: string
}

export interface Self {
	isAccountConnected: boolean
}

export interface TimeBasedDrop {
	id: string
	requiredSubs: number
	benefitEdges: BenefitEdge[]
	endAt: string
	name: string
	preconditionDrops: null
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
	game: Game
	imageAssetURL: string
	isIosAvailable: boolean
	name: string
	ownerOrganization: Game
}
