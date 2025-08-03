import { TimeBasedDrop as InventoryDrop } from './Inventory';

export interface CampaignDetails {
  user: User;
}

export interface User {
  id: string;
  dropCampaign: DropCampaign;
}

export interface DropCampaign {
  id: string;
  self: Self;
  allow: Allow;
  accountLinkURL: string;
  description: string;
  detailsURL: string;
  endAt: string;
  eventBasedDrops: string[];
  game: Game;
  imageURL: string;
  name: string;
  owner: Game;
  startAt: string;
  status: string;
  timeBasedDrops: Omit<InventoryDrop, 'self' | 'campaign'>[];
}

export interface Allow {
  channels: Required<Pick<Game, 'name'>>[] | null;
  isEnabled: boolean;
}

export interface Game {
  id: string;
  name?: string;
  slug?: string;
  displayName?: string;
}

export interface Self {
  isAccountConnected: boolean;
}

export interface BenefitEdge {
  benefit: Benefit;
  entitlementLimit: number;
}

export interface Benefit {
  id: string;
  createdAt: string;
  entitlementLimit: number;
  game: Game;
  imageAssetURL: string;
  isIosAvailable: boolean;
  name: string;
  ownerOrganization: Game;
}
