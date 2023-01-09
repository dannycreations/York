export interface DirectoryPageGame {
	game: Required<Omit<Game, 'boxArtURL'>> | null
}

export interface Node {
	id: string
	title: string
	viewersCount: number
	previewImageURL: string
	broadcaster: Broadcaster
	freeformTags: FreeformTag[]
	type: string
	game: Required<Omit<Game, 'streams'>>
}

export interface Edge {
	cursor: string
	node: Node
	trackingID: string
}

export interface Streams {
	edges: Edge[]
	pageInfo: PageInfo
}

export interface Game {
	id: string
	name: string
	displayName: string
	streams: Streams
	boxArtURL: string
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

export interface PageInfo {
	hasNextPage: boolean
}
