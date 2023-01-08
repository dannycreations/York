export interface DropCurrentSessionContext {
	currentUser: CurrentUser
}

export interface CurrentUser {
	id: string
	dropCurrentSession: DropCurrentSession | null
}

export interface DropCurrentSession {
	channel: Channel
	game: Omit<Channel, 'name'>
	currentMinutesWatched: number
	requiredMinutesWatched: number
	dropID: string
}

export interface Channel {
	id: string
	name: string
	displayName: string
}
