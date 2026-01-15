export interface ChannelDrops {
  readonly channel: Channel;
}

export interface Channel {
  readonly id: string;
  readonly viewerDropCampaigns: readonly ViewerDropCampaign[] | null;
}

export interface ViewerDropCampaign {
  readonly id: string;
  readonly name: string;
  readonly game: Game;
  readonly detailsURL: string;
  readonly endAt: Date;
  readonly imageURL: string;
  readonly eventBasedDrops: readonly unknown[];
  readonly timeBasedDrops: readonly TimeBasedDrop[];
  readonly summary: Summary;
}

export interface Game {
  readonly id: string;
  readonly name: string;
}

export interface Summary {
  readonly includesMWRequirement: boolean;
  readonly includesSubRequirement: boolean;
  readonly isSitewide: boolean;
  readonly isRewardCampaign: boolean;
  readonly isPermanentlyDismissible: boolean;
}

export interface TimeBasedDrop {
  readonly id: string;
  readonly name: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly benefitEdges: readonly BenefitEdge[];
  readonly requiredMinutesWatched: number;
}

export interface BenefitEdge {
  readonly benefit: Benefit;
  readonly entitlementLimit: number;
}

export interface Benefit {
  readonly id: string;
  readonly name: string;
  readonly game: Game;
  readonly imageAssetURL: string;
}
