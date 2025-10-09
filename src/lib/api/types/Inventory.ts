import type { DropStatus } from '../../constants/Enum';

export interface Inventory {
  readonly currentUser: CurrentUser;
}

export interface CurrentUser {
  readonly id: string;
  readonly inventory: InventoryData;
}

export interface InventoryData {
  readonly dropCampaignsInProgress: readonly DropCampaignsInProgress[];
  readonly gameEventDrops: readonly GameEventDrop[];
  readonly completedRewardCampaigns: readonly CompletedRewardCampaign[];
}

export interface CompletedRewardCampaign {
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
  readonly game: CompletedRewardCampaignGame;
  readonly unlockRequirements: UnlockRequirements;
  readonly image: Image;
  readonly rewards: readonly Reward[];
}

export interface CompletedRewardCampaignGame {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
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

export interface DropCampaignsInProgress {
  readonly id: string;
  readonly detailsURL: string;
  readonly accountLinkURL: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly imageURL: string;
  readonly name: string;
  readonly status: DropStatus;
  readonly self: DropCampaignsInProgressSelf;
  readonly game: DropCampaignsInProgressGame;
  readonly allow: Allow;
  readonly eventBasedDrops: readonly string[];
  readonly timeBasedDrops: readonly TimeBasedDrop[];
}

export interface Allow {
  readonly channels: readonly Channel[] | null;
}

export interface Channel {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
  readonly boxArtURL?: string;
  readonly imageAssetURL?: string;
}

export interface DropCampaignsInProgressGame {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly boxArtURL: string;
}

export interface DropCampaignsInProgressSelf {
  readonly isAccountConnected: boolean;
}

export interface TimeBasedDrop {
  readonly id: string;
  readonly name: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly preconditionDrops: null;
  readonly requiredMinutesWatched: number;
  readonly requiredSubs: number;
  readonly benefitEdges: readonly BenefitEdge[];
  readonly self: TimeBasedDropSelf;
  readonly campaign: Campaign;
}

export interface BenefitEdge {
  readonly benefit: Channel;
  readonly entitlementLimit: number;
  readonly claimCount: number;
}

export interface Campaign {
  readonly id: string;
  readonly detailsURL: string;
  readonly accountLinkURL: string;
  readonly self: DropCampaignsInProgressSelf;
}

export interface TimeBasedDropSelf {
  readonly hasPreconditionsMet: boolean;
  readonly currentMinutesWatched: number;
  readonly currentSubs: number;
  readonly isClaimed: boolean;
  readonly dropInstanceID: string | null;
}

export interface GameEventDrop {
  readonly game: null;
  readonly id: string;
  readonly imageURL: string;
  readonly isConnected: boolean;
  readonly lastAwardedAt: string;
  readonly name: string;
  readonly requiredAccountLink: string;
  readonly totalCount: number;
}
