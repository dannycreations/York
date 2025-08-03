export interface ClaimDrops {
  claimDropRewards: ClaimDropRewards;
}

export interface ClaimDropRewards {
  status: string;
  isUserAccountConnected: boolean;
  dropType: DropType;
}

export interface DropType {
  id: string;
  campaign: Campaign;
}

export interface Campaign {
  id: string;
  detailsURL: string;
}
