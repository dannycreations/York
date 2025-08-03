export interface ClaimPoints {
  claimCommunityPoints: ClaimCommunityPoints;
}

export interface ClaimCommunityPoints {
  claim: Claim;
  currentPoints: number;
  error: null;
}

export interface Claim {
  id: string;
  multipliers: string[];
  pointsEarnedBaseline: number;
  pointsEarnedTotal: number;
}
