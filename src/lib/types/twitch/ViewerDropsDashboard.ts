import { Status } from '../Enum'

export interface ViewerDropsDashboard {
	currentUser: CurrentUser
	rewardCampaignsAvailableToUser: unknown[]
}

export interface CurrentUser {
	id: string
	login: string
	dropCampaigns: DropCampaign[]
}

export interface DropCampaign {
	id: string
	name: string
	owner: Owner
	game: Game
	status: Status
	startAt: string
	endAt: string
	detailsURL: string
	accountLinkURL: string
	self: Self
}

export interface Game {
	id: string
	displayName: string
	boxArtURL: string
}

export interface Owner {
	id: string
	name: string
}

export interface Self {
	isAccountConnected: boolean
}
