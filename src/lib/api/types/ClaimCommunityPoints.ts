export interface ClaimCommunityPoints {
	claimCommunityPoints: ClaimCommunityPointsClass
}

export interface ClaimCommunityPointsClass {
	claim: Claim
	currentPoints: number
	error: null
}

export interface Claim {
	id: string
	multipliers: any[]
	pointsEarnedBaseline: number
	pointsEarnedTotal: number
}
