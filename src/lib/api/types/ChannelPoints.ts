export interface ChannelPoints {
  community: Community;
  currentUser: CurrentUser;
}

export interface Community {
  id: string;
  displayName: string;
  channel: Channel;
  self: CommunitySelf;
}

export interface Channel {
  id: string;
  self: ChannelSelf;
  communityPointsSettings: CommunityPointsSettings;
}

export interface CommunityPointsSettings {
  name: string | null;
  image: Image | null;
  automaticRewards: AutomaticReward[];
  customRewards: CustomReward[];
  goals: string[];
  isEnabled: boolean;
  raidPointAmount: number;
  emoteVariants: EmoteVariant[];
  earning: Earning;
}

export interface AutomaticReward {
  id: string;
  backgroundColor: string | null;
  cost: number | null;
  defaultBackgroundColor: string;
  defaultCost: number;
  defaultImage: Image;
  image: null;
  isEnabled: boolean;
  isHiddenForSubs: boolean;
  minimumCost: number;
  type: string;
  updatedForIndicatorAt: string | null;
  globallyUpdatedForIndicatorAt: string;
}

export interface Image {
  url: string;
  url2x: string;
  url4x: string;
}

export interface CustomReward {
  id: string;
  backgroundColor: string;
  cooldownExpiresAt: string | null;
  cost: number;
  defaultImage: Image;
  image: Image | null;
  maxPerStreamSetting: MaxPerStreamSetting;
  maxPerUserPerStreamSetting: MaxPerUserPerStreamSetting;
  globalCooldownSetting: GlobalCooldownSetting;
  isEnabled: boolean;
  isInStock: boolean;
  isPaused: boolean;
  isSubOnly: boolean;
  isUserInputRequired: boolean;
  shouldRedemptionsSkipRequestQueue: boolean;
  redemptionsRedeemedCurrentStream: number | null;
  prompt: string | null;
  title: string;
  updatedForIndicatorAt: string;
}

export interface GlobalCooldownSetting {
  isEnabled: boolean;
  globalCooldownSeconds: number;
}

export interface MaxPerStreamSetting {
  isEnabled: boolean;
  maxPerStream: number;
}

export interface MaxPerUserPerStreamSetting {
  isEnabled: boolean;
  maxPerUserPerStream: number;
}

export interface Earning {
  id: string;
  averagePointsPerHour: number;
  cheerPoints: number;
  claimPoints: number;
  followPoints: number;
  passiveWatchPoints: number;
  raidPoints: number;
  subscriptionGiftPoints: number;
  watchStreakPoints: WatchStreakPoint[];
  multipliers: Multiplier[];
}

export interface Multiplier {
  reasonCode: string;
  factor: number;
}

export interface WatchStreakPoint {
  points: number;
}

export interface EmoteVariant {
  id: string;
  isUnlockable: boolean;
  emote: Emote;
  modifications: Modification[];
}

export interface Emote {
  id: string;
  token: string;
}

export interface Modification {
  id: string;
  emote: Emote;
  modifier: Reward;
  globallyUpdatedForIndicatorAt: string;
}

export interface Reward {
  id: string;
}

export interface ChannelSelf {
  communityPoints: SelfCommunityPoints;
}

export interface SelfCommunityPoints {
  availableClaim: Reward | null;
  balance: number;
  activeMultipliers: string[];
  canRedeemRewardsForFree: boolean;
  lastViewedContent: LastViewedContent[];
  userRedemptions: UserRedemption[];
}

export interface LastViewedContent {
  contentType: string;
  lastViewedAt: string;
  contentID?: string;
}

export interface UserRedemption {
  reward: Reward;
  userRedemptionsCurrentStream: number;
}

export interface CommunitySelf {
  isModerator: boolean;
}

export interface CurrentUser {
  id: string;
  communityPoints: CurrentUserCommunityPoints;
}

export interface CurrentUserCommunityPoints {
  lastViewedContent: LastViewedContent[];
}
