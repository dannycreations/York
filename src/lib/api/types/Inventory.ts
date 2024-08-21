import { Status } from '../constants/Enum'

export interface Inventory {
	currentUser: CurrentUser
}

export interface CurrentUser {
	id: string
	inventory: InventoryData
}

export interface InventoryData {
	dropCampaignsInProgress: DropCampaignsInProgress[]
	gameEventDrops: GameEventDrop[]
	completedRewardCampaigns: any[]
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
	game: Game
	allow: Allow
	eventBasedDrops: any[]
	timeBasedDrops: TimeBasedDrop[]
}

export interface Allow {
	channels: Game[] | null
}

export interface Game {
	id: string
	name: string
	url?: string
	boxArtURL?: string
	imageAssetURL?: string
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
	requiredSubs: number
	benefitEdges: BenefitEdge[]
	self: TimeBasedDropSelf
	campaign: Campaign
}

export interface BenefitEdge {
	benefit: Game
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
	currentSubs: number
	isClaimed: boolean
	dropInstanceID: string | null
}

export interface GameEventDrop {
	game: null
	id: string
	imageURL: string
	isConnected: boolean
	lastAwardedAt: string
	name: string
	requiredAccountLink: string
	totalCount: number
}
