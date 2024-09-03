export interface ClaimDropRewards {
	claimDropRewards: ClaimDropRewardsClass
}

export interface ClaimDropRewardsClass {
	status: string
	isUserAccountConnected: boolean
	dropType: DropType
}

export interface DropType {
	id: string
	campaign: Campaign
}

export interface Campaign {
	id: string
	detailsURL: string
}
