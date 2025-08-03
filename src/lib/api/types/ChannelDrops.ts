export interface ChannelDrops {
  channel: Channel;
}

export interface Channel {
  id: string;
  viewerDropCampaigns: ViewerDropCampaign[] | null;
}

export interface ViewerDropCampaign {
  id: string;
  name: string;
  game: Game;
  detailsURL: string;
  endAt: Date;
  imageURL: string;
  eventBasedDrops: any[];
  timeBasedDrops: TimeBasedDrop[];
  summary: Summary;
}

export interface Game {
  id: string;
  name: string;
}

export interface Summary {
  includesMWRequirement: boolean;
  includesSubRequirement: boolean;
  isSitewide: boolean;
  isRewardCampaign: boolean;
  isPermanentlyDismissible: boolean;
}

export interface TimeBasedDrop {
  id: string;
  name: string;
  startAt: Date;
  endAt: Date;
  benefitEdges: BenefitEdge[];
  requiredMinutesWatched: number;
}

export interface BenefitEdge {
  benefit: Benefit;
  entitlementLimit: number;
}

export interface Benefit {
  id: string;
  name: string;
  game: Game;
  imageAssetURL: string;
}
