export interface GameDirectory {
  game: Game;
}

export interface Game {
  id: string;
  name: string;
  displayName: string;
  streams: Streams;
}

export interface Streams {
  banners: null;
  edges: Edge[];
  pageInfo: PageInfo;
}

export interface Edge {
  cursor: string;
  node: Node;
  trackingID: string | null;
}

export interface Node {
  id: string;
  title: string;
  viewersCount: number;
  previewImageURL: string;
  broadcaster: Broadcaster;
  freeformTags: FreeformTag[];
  type: string;
  game: NodeGame;
  previewThumbnailProperties: PreviewThumbnailProperties;
}

export interface Broadcaster {
  id: string;
  login: string;
  displayName: string;
  roles: Roles;
  profileImageURL: string;
  primaryColorHex: null | string;
}

export interface Roles {
  isPartner: boolean;
  isParticipatingDJ: boolean;
}

export interface FreeformTag {
  id: string;
  name: string;
}

export interface NodeGame {
  id: string;
  boxArtURL: string;
  name: string;
  displayName: string;
  slug: string;
}

export interface PreviewThumbnailProperties {
  blurReason: string;
}

export interface PageInfo {
  hasNextPage: boolean;
}
