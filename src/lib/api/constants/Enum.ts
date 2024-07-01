export enum Common {
	ApiUrl = 'https://gql.twitch.tv',
	WssUrl = 'wss://pubsub-edge.twitch.tv/v1',
}

export enum Status {
	Active = 'ACTIVE',
	Expired = 'EXPIRED',
	Upcoming = 'UPCOMING',
}

export enum Tasks {
	DropMain = 'DROPMAIN',
	DropOffline = 'DROPOFFLINE',
	DropUpcoming = 'DROPUPCOMING',
}

export const ERROR_CODES = ['ETIMEDOUT', 'ECONNRESET', 'EADDRINUSE', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNABORTED']
