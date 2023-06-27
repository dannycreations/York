export enum Constants {
	ApiUrl = 'https://gql.twitch.tv',
	WssUrl = 'wss://pubsub-edge.twitch.tv',
	DropTag = 'c2542d6d-cd10-4532-919b-3d19f30a768b',
	SpadeReg = `(https://video-edge-[.\\w\\-/]+\\.ts)`,
	SettingReg = `https://static\.twitchcdn\.net/config/settings\.[0-9a-f]{32}\.js`,
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
