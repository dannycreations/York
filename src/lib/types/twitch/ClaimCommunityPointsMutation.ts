export interface ClaimCommunityPointsMutation {
	claimCommunityPoints: ClaimCommunityPoints
}

export interface ClaimCommunityPoints {
	claim: Claim
	error: null
}

export interface Claim {
	id: string
	multipliers: any[]
	pointsEarnedTotal: number
	pointsEarnedBaseline: number
}
