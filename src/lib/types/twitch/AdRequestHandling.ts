export interface AdRequestHandling {
	currentUser: CurrentUser
	user: User
}

export interface CurrentUser {
	id: string
	hasTurbo: boolean
}

export interface User {
	id: string
	login: string
	adProperties: AdProperties
	self: Self
	roles: Roles
	broadcastSettings: BroadcastSettings
	stream: Stream | null
}

export interface AdProperties {
	adServerDefault: string
	hasPrerollsDisabled: boolean
	hasPostrollsDisabled: boolean
	hasVodAdsEnabled: boolean
	vodArchiveMidrolls: string
}

export interface BroadcastSettings {
	id: string
	isMature: boolean
}

export interface Roles {
	isAffiliate: boolean
	isPartner: boolean
}

export interface Self {
	subscriptionBenefit: null
}

export interface Stream {
	id: string
	broadcasterSoftware: string
	game: Game
	tags: Tag[]
}

export interface Game {
	id: string
	name: string
	tags: Tag[]
}

export interface Tag {
	id: string
	tagName: string
}
