export interface DirectoryPageGame {
	game: DirectoryPageGameGame
}

export interface DirectoryPageGameGame {
	id: string
	name: string
	displayName: string
	streams: Streams
}

export interface Streams {
	edges: Edge[]
	pageInfo: PageInfo
}

export interface Edge {
	cursor: string
	node: Node
	trackingID: string
}

export interface Node {
	id: string
	title: string
	viewersCount: number
	previewImageURL: string
	broadcaster: Broadcaster
	freeformTags: FreeformTag[]
	type: string
	game: NodeGame
}

export interface Broadcaster {
	id: string
	login: string
	displayName: string
	roles: Roles
	profileImageURL: string
	primaryColorHex: null | string
}

export interface Roles {
	isPartner: boolean
}

export interface FreeformTag {
	id: string
	name: string
}

export interface NodeGame {
	id: string
	boxArtURL: string
	name: string
	displayName: string
	slug: string
}

export interface PageInfo {
	hasNextPage: boolean
}
