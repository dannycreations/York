import { DropStatus } from '../../constants/Enum';

export interface DropsDashboard {
  currentUser: CurrentUser;
  rewardCampaignsAvailableToUser: RewardCampaignsAvailableToUser[];
}

export interface CurrentUser {
  id: string;
  login: string;
  dropCampaigns: DropCampaign[];
}

export interface DropCampaign {
  id: string;
  name: string;
  owner: Owner;
  game: Game;
  status: DropStatus;
  startAt: string;
  endAt: string;
  detailsURL: string;
  accountLinkURL: string;
  self: Self;
}

export interface Game {
  id: string;
  displayName: string;
  boxArtURL?: string;
}

export interface Owner {
  id: string;
  name: string;
}

export interface Self {
  isAccountConnected: boolean;
}

export interface RewardCampaignsAvailableToUser {
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
  game: Game | null;
  unlockRequirements: UnlockRequirements;
  image: Image;
  rewards: Reward[];
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
