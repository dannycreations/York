import type { DropStatus } from '../../constants/Enum';

export interface DropsDashboard {
  readonly currentUser: CurrentUser;
  readonly rewardCampaignsAvailableToUser: readonly RewardCampaignsAvailableToUser[];
}

export interface CurrentUser {
  readonly id: string;
  readonly login: string;
  readonly dropCampaigns: readonly DropCampaign[];
}

export interface DropCampaign {
  readonly id: string;
  readonly name: string;
  readonly owner: Owner;
  readonly game: Game;
  readonly status: DropStatus;
  readonly startAt: string;
  readonly endAt: string;
  readonly detailsURL: string;
  readonly accountLinkURL: string;
  readonly self: Self;
}

export interface Game {
  readonly id: string;
  readonly displayName: string;
  readonly boxArtURL?: string;
}

export interface Owner {
  readonly id: string;
  readonly name: string;
}

export interface Self {
  readonly isAccountConnected: boolean;
}

export interface RewardCampaignsAvailableToUser {
  readonly id: string;
  readonly name: string;
  readonly brand: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: string;
  readonly summary: string;
  readonly instructions: string;
  readonly externalURL: string;
  readonly rewardValueURLParam: string;
  readonly aboutURL: string;
  readonly isSitewide: boolean;
  readonly game: Game | null;
  readonly unlockRequirements: UnlockRequirements;
  readonly image: Image;
  readonly rewards: readonly Reward[];
}

export interface Image {
  readonly image1xURL: string;
}

export interface Reward {
  readonly id: string;
  readonly name: string;
  readonly bannerImage: Image;
  readonly thumbnailImage: Image;
  readonly earnableUntil: string;
  readonly redemptionInstructions: string;
  readonly redemptionURL: string;
}

export interface UnlockRequirements {
  readonly subsGoal: number;
  readonly minuteWatchedGoal: number;
}
