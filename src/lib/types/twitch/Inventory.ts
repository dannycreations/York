import { Status } from '../Enum'

export interface Inventory {
	currentUser: CurrentUser
}

export interface CurrentUser {
	id: string
	inventory: UserInventory
}

export interface UserInventory {
	dropCampaignsInProgress: DropCampaignsInProgress[] | null
	gameEventDrops: GameEventDrop[]
	completedRewardCampaigns: unknown[]
}

export interface DropCampaignsInProgress {
	id: string
	detailsURL: string
	accountLinkURL: string
	startAt: string
	endAt: string
	imageURL: string
	name: string
	status: Status
	self: DropCampaignsInProgressSelf
	game: Omit<Game, 'url' | 'imageAssetURL'>
	allow: Allow
	eventBasedDrops: unknown[]
	timeBasedDrops: TimeBasedDrop[]
}

export interface Allow {
	channels: Omit<Game, 'boxArtURL' | 'imageAssetURL'>[] | null
}

interface Game {
	id: string
	name: string
	url: string
	boxArtURL: string
	imageAssetURL: string
}

export interface DropCampaignsInProgressSelf {
	isAccountConnected: boolean
}

export interface TimeBasedDrop {
	id: string
	name: string
	startAt: string
	endAt: string
	preconditionDrops: PreconditionDrop[] | null
	requiredMinutesWatched: number
	benefitEdges: BenefitEdge[]
	self: TimeBasedDropSelf
	campaign: Campaign
}

export interface BenefitEdge {
	benefit: Omit<Game, 'url' | 'boxArtURL'>
	entitlementLimit: number
	claimCount: number
}

export interface Campaign {
	id: string
	detailsURL: string
	accountLinkURL: string
	self: DropCampaignsInProgressSelf
}

export interface PreconditionDrop {
	id: string
}

export interface TimeBasedDropSelf {
	hasPreconditionsMet: boolean
	currentMinutesWatched: number
	isClaimed: boolean
	dropInstanceID: string | null
}

export interface GameEventDrop {
	game: Pick<Game, 'id' | 'name'>
	id: string
	imageURL: string
	isConnected: boolean
	lastAwardedAt: string
	name: string
	requiredAccountLink: string
	totalCount: number
}
