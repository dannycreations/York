import { DropStatus } from '../../constants/Enum';

export interface Inventory {
  currentUser: CurrentUser;
}

export interface CurrentUser {
  id: string;
  inventory: InventoryData;
}

export interface InventoryData {
  dropCampaignsInProgress: DropCampaignsInProgress[];
  gameEventDrops: GameEventDrop[];
  completedRewardCampaigns: CompletedRewardCampaign[];
}

export interface CompletedRewardCampaign {
  id: string;
  name: string;
  brand: string;
  startsAt: string;
  endsAt: string;
  status: string;
  summary: string;
  instructions: string;
  externalURL: string;
  rewardValueURLParam: string;
  aboutURL: string;
  isSitewide: boolean;
  game: CompletedRewardCampaignGame;
  unlockRequirements: UnlockRequirements;
  image: Image;
  rewards: Reward[];
}

export interface CompletedRewardCampaignGame {
  id: string;
  slug: string;
  displayName: string;
}

export interface Image {
  image1xURL: string;
}

export interface Reward {
  id: string;
  name: string;
  bannerImage: Image;
  thumbnailImage: Image;
  earnableUntil: string;
  redemptionInstructions: string;
  redemptionURL: string;
}

export interface UnlockRequirements {
  subsGoal: number;
  minuteWatchedGoal: number;
}

export interface DropCampaignsInProgress {
  id: string;
  detailsURL: string;
  accountLinkURL: string;
  startAt: string;
  endAt: string;
  imageURL: string;
  name: string;
  status: DropStatus;
  self: DropCampaignsInProgressSelf;
  game: DropCampaignsInProgressGame;
  allow: Allow;
  eventBasedDrops: string[];
  timeBasedDrops: TimeBasedDrop[];
}

export interface Allow {
  channels: Channel[] | null;
}

export interface Channel {
  id: string;
  name: string;
  url?: string;
  boxArtURL?: string;
  imageAssetURL?: string;
}

export interface DropCampaignsInProgressGame {
  id: string;
  slug: string;
  name: string;
  boxArtURL: string;
}

export interface DropCampaignsInProgressSelf {
  isAccountConnected: boolean;
}

export interface TimeBasedDrop {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  preconditionDrops: null;
  requiredMinutesWatched: number;
  requiredSubs: number;
  benefitEdges: BenefitEdge[];
  self: TimeBasedDropSelf;
  campaign: Campaign;
}

export interface BenefitEdge {
  benefit: Channel;
  entitlementLimit: number;
  claimCount: number;
}

export interface Campaign {
  id: string;
  detailsURL: string;
  accountLinkURL: string;
  self: DropCampaignsInProgressSelf;
}

export interface TimeBasedDropSelf {
  hasPreconditionsMet: boolean;
  currentMinutesWatched: number;
  currentSubs: number;
  isClaimed: boolean;
  dropInstanceID: string | null;
}

export interface GameEventDrop {
  game: null;
  id: string;
  imageURL: string;
  isConnected: boolean;
  lastAwardedAt: string;
  name: string;
  requiredAccountLink: string;
  totalCount: number;
}
