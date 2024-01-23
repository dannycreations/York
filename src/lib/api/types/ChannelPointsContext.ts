export interface ChannelPointsContext {
	community: Community
	currentUser: CurrentUser
}

export interface Community {
	id: string
	displayName: string
	channel: Channel
	self: CommunitySelf
}

export interface Channel {
	id: string
	self: ChannelSelf
	communityPointsSettings: CommunityPointsSettings
}

export interface CommunityPointsSettings {
	name: null
	image: null
	automaticRewards: AutomaticReward[]
	customRewards: CustomReward[]
	goals: any[]
	isEnabled: boolean
	raidPointAmount: number
	emoteVariants: EmoteVariant[]
	earning: Earning
}

export interface AutomaticReward {
	id: string
	backgroundColor: null
	cost: null
	defaultBackgroundColor: string
	defaultCost: number
	defaultImage: DefaultImage
	image: null
	isEnabled: boolean
	isHiddenForSubs: boolean
	minimumCost: number
	type: string
	updatedForIndicatorAt: string
	globallyUpdatedForIndicatorAt: string
}

export interface DefaultImage {
	url: string
	url2x: string
	url4x: string
}

export interface CustomReward {
	id: string
	backgroundColor: string
	cooldownExpiresAt: null
	cost: number
	defaultImage: DefaultImage
	image: null
	maxPerStreamSetting: MaxPerStreamSetting
	maxPerUserPerStreamSetting: MaxPerUserPerStreamSetting
	globalCooldownSetting: GlobalCooldownSetting
	isEnabled: boolean
	isInStock: boolean
	isPaused: boolean
	isSubOnly: boolean
	isUserInputRequired: boolean
	shouldRedemptionsSkipRequestQueue: boolean
	redemptionsRedeemedCurrentStream: null
	prompt: null | string
	title: string
	updatedForIndicatorAt: string
}

export interface GlobalCooldownSetting {
	isEnabled: boolean
	globalCooldownSeconds: number
}

export interface MaxPerStreamSetting {
	isEnabled: boolean
	maxPerStream: number
}

export interface MaxPerUserPerStreamSetting {
	isEnabled: boolean
	maxPerUserPerStream: number
}

export interface Earning {
	id: string
	averagePointsPerHour: number
	cheerPoints: number
	claimPoints: number
	followPoints: number
	passiveWatchPoints: number
	raidPoints: number
	subscriptionGiftPoints: number
	watchStreakPoints: WatchStreakPoint[]
	multipliers: Multiplier[]
}

export interface Multiplier {
	reasonCode: string
	factor: number
}

export interface WatchStreakPoint {
	points: number
}

export interface EmoteVariant {
	id: string
	isUnlockable: boolean
	emote: Emote
	modifications: Modification[]
}

export interface Emote {
	id: string
	token: string
}

export interface Modification {
	id: string
	emote: Emote
	modifier: Modifier
	globallyUpdatedForIndicatorAt: string
}

export interface Modifier {
	id: ID
}

export enum ID {
	ModBW = 'MOD_BW',
	ModHF = 'MOD_HF',
	ModSg = 'MOD_SG',
	ModSq = 'MOD_SQ',
	ModTk = 'MOD_TK',
}

export interface ChannelSelf {
	communityPoints: SelfCommunityPoints
}

export interface SelfCommunityPoints {
	availableClaim: Reward | null
	balance: number
	activeMultipliers: any[]
	canRedeemRewardsForFree: boolean
	lastViewedContent: LastViewedContent[]
	userRedemptions: any[]
}

export interface Reward {
	id: string
}

export interface LastViewedContent {
	contentType: string
	lastViewedAt: string
	contentID?: string
}

export interface CommunitySelf {
	isModerator: boolean
}

export interface CurrentUser {
	id: string
	communityPoints: CurrentUserCommunityPoints
}

export interface CurrentUserCommunityPoints {
	lastViewedContent: LastViewedContent[]
}
