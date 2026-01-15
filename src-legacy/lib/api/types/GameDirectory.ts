export interface GameDirectory {
  readonly game: Game;
}

export interface Game {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly streams: Streams;
}

export interface Streams {
  readonly banners: null;
  readonly edges: readonly Edge[];
  readonly pageInfo: PageInfo;
}

export interface Edge {
  readonly cursor: string;
  readonly node: Node;
  readonly trackingID: string | null;
}

export interface Node {
  readonly id: string;
  readonly title: string;
  readonly viewersCount: number;
  readonly previewImageURL: string;
  readonly broadcaster: Broadcaster;
  readonly freeformTags: readonly FreeformTag[];
  readonly type: string;
  readonly game: NodeGame;
  readonly previewThumbnailProperties: PreviewThumbnailProperties;
}

export interface Broadcaster {
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
  readonly roles: Roles;
  readonly profileImageURL: string;
  readonly primaryColorHex: null | string;
}

export interface Roles {
  readonly isPartner: boolean;
  readonly isParticipatingDJ: boolean;
}

export interface FreeformTag {
  readonly id: string;
  readonly name: string;
}

export interface NodeGame {
  readonly id: string;
  readonly boxArtURL: string;
  readonly name: string;
  readonly displayName: string;
  readonly slug: string;
}

export interface PreviewThumbnailProperties {
  readonly blurReason: string;
}

export interface PageInfo {
  readonly hasNextPage: boolean;
}
