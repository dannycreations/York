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
	DropMain = 'dropMain',
	DropOffline = 'dropOffline',
	DropUpcoming = 'dropUpcoming',
}
