import type { TimeBasedDrop } from './Inventory';

export interface CampaignDetails {
  readonly user: User;
}

export interface User {
  readonly id: string;
  readonly dropCampaign: DropCampaign;
}

export interface DropCampaign {
  readonly id: string;
  readonly self: Self;
  readonly allow: Allow;
  readonly accountLinkURL: string;
  readonly description: string;
  readonly detailsURL: string;
  readonly endAt: string;
  readonly eventBasedDrops: readonly string[];
  readonly game: Game;
  readonly imageURL: string;
  readonly name: string;
  readonly owner: Game;
  readonly startAt: string;
  readonly status: string;
  readonly timeBasedDrops: readonly Omit<TimeBasedDrop, 'self' | 'campaign'>[];
}

export interface Allow {
  readonly channels: readonly Required<Pick<Game, 'name'>>[] | null;
  readonly isEnabled: boolean;
}

export interface Game {
  readonly id: string;
  readonly name?: string;
  readonly slug?: string;
  readonly displayName?: string;
}

export interface Self {
  readonly isAccountConnected: boolean;
}

export interface BenefitEdge {
  readonly benefit: Benefit;
  readonly entitlementLimit: number;
}

export interface Benefit {
  readonly id: string;
  readonly createdAt: string;
  readonly entitlementLimit: number;
  readonly game: Game;
  readonly imageAssetURL: string;
  readonly isIosAvailable: boolean;
  readonly name: string;
  readonly ownerOrganization: Game;
}
