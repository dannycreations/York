export interface ChannelPoints {
  readonly community: Community;
  readonly currentUser: CurrentUser;
}

export interface Community {
  readonly id: string;
  readonly displayName: string;
  readonly channel: Channel;
  readonly self: CommunitySelf;
}

export interface Channel {
  readonly id: string;
  readonly self: ChannelSelf;
  readonly communityPointsSettings: CommunityPointsSettings;
}

export interface CommunityPointsSettings {
  readonly name: string | null;
  readonly image: Image | null;
  readonly automaticRewards: readonly AutomaticReward[];
  readonly customRewards: readonly CustomReward[];
  readonly goals: readonly string[];
  readonly isEnabled: boolean;
  readonly raidPointAmount: number;
  readonly emoteVariants: readonly EmoteVariant[];
  readonly earning: Earning;
}

export interface AutomaticReward {
  readonly id: string;
  readonly backgroundColor: string | null;
  readonly cost: number | null;
  readonly defaultBackgroundColor: string;
  readonly defaultCost: number;
  readonly defaultImage: Image;
  readonly image: null;
  readonly isEnabled: boolean;
  readonly isHiddenForSubs: boolean;
  readonly minimumCost: number;
  readonly type: string;
  readonly updatedForIndicatorAt: string | null;
  readonly globallyUpdatedForIndicatorAt: string;
}

export interface Image {
  readonly url: string;
  readonly url2x: string;
  readonly url4x: string;
}

export interface CustomReward {
  readonly id: string;
  readonly backgroundColor: string;
  readonly cooldownExpiresAt: string | null;
  readonly cost: number;
  readonly defaultImage: Image;
  readonly image: Image | null;
  readonly maxPerStreamSetting: MaxPerStreamSetting;
  readonly maxPerUserPerStreamSetting: MaxPerUserPerStreamSetting;
  readonly globalCooldownSetting: GlobalCooldownSetting;
  readonly isEnabled: boolean;
  readonly isInStock: boolean;
  readonly isPaused: boolean;
  readonly isSubOnly: boolean;
  readonly isUserInputRequired: boolean;
  readonly shouldRedemptionsSkipRequestQueue: boolean;
  readonly redemptionsRedeemedCurrentStream: number | null;
  readonly prompt: string | null;
  readonly title: string;
  readonly updatedForIndicatorAt: string;
}

export interface GlobalCooldownSetting {
  readonly isEnabled: boolean;
  readonly globalCooldownSeconds: number;
}

export interface MaxPerStreamSetting {
  readonly isEnabled: boolean;
  readonly maxPerStream: number;
}

export interface MaxPerUserPerStreamSetting {
  readonly isEnabled: boolean;
  readonly maxPerUserPerStream: number;
}

export interface Earning {
  readonly id: string;
  readonly averagePointsPerHour: number;
  readonly cheerPoints: number;
  readonly claimPoints: number;
  readonly followPoints: number;
  readonly passiveWatchPoints: number;
  readonly raidPoints: number;
  readonly subscriptionGiftPoints: number;
  readonly watchStreakPoints: readonly WatchStreakPoint[];
  readonly multipliers: readonly Multiplier[];
}

export interface Multiplier {
  readonly reasonCode: string;
  readonly factor: number;
}

export interface WatchStreakPoint {
  readonly points: number;
}

export interface EmoteVariant {
  readonly id: string;
  readonly isUnlockable: boolean;
  readonly emote: Emote;
  readonly modifications: readonly Modification[];
}

export interface Emote {
  readonly id: string;
  readonly token: string;
}

export interface Modification {
  readonly id: string;
  readonly emote: Emote;
  readonly modifier: Reward;
  readonly globallyUpdatedForIndicatorAt: string;
}

export interface Reward {
  readonly id: string;
}

export interface ChannelSelf {
  readonly communityPoints: SelfCommunityPoints;
}

export interface SelfCommunityPoints {
  readonly availableClaim: Reward | null;
  readonly balance: number;
  readonly activeMultipliers: readonly string[];
  readonly canRedeemRewardsForFree: boolean;
  readonly lastViewedContent: readonly LastViewedContent[];
  readonly userRedemptions: readonly UserRedemption[];
}

export interface LastViewedContent {
  readonly contentType: string;
  readonly lastViewedAt: string;
  readonly contentID?: string;
}

export interface UserRedemption {
  readonly reward: Reward;
  readonly userRedemptionsCurrentStream: number;
}

export interface CommunitySelf {
  readonly isModerator: boolean;
}

export interface CurrentUser {
  readonly id: string;
  readonly communityPoints: CurrentUserCommunityPoints;
}

export interface CurrentUserCommunityPoints {
  readonly lastViewedContent: readonly LastViewedContent[];
}
