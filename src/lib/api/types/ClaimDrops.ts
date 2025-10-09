export interface ClaimDrops {
  readonly claimDropRewards: ClaimDropRewards;
}

export interface ClaimDropRewards {
  readonly status: string;
  readonly isUserAccountConnected: boolean;
  readonly dropType: DropType;
}

export interface DropType {
  readonly id: string;
  readonly campaign: Campaign;
}

export interface Campaign {
  readonly id: string;
  readonly detailsURL: string;
}
