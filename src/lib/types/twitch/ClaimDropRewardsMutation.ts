export interface ClaimDropRewardsMutation {
	claimDropRewards: ClaimDropRewards
}

export interface ClaimDropRewards {
	dropInstanceID: string
	status: string
	dropType: DropType
	isUserAccountConnected: boolean
}

export interface DropType {
	id: string
	campaign: Campaign
}

export interface Campaign {
	id: string
}
