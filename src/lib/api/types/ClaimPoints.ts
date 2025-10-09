export interface ClaimPoints {
  readonly claimCommunityPoints: ClaimCommunityPoints;
}

export interface ClaimCommunityPoints {
  readonly claim: Claim;
  readonly currentPoints: number;
  readonly error: null;
}

export interface Claim {
  readonly id: string;
  readonly multipliers: readonly string[];
  readonly pointsEarnedBaseline: number;
  readonly pointsEarnedTotal: number;
}
