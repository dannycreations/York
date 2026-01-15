import type { ResponseContent } from '../api/types/WebSocket';

export enum Twitch {
  WebUrl = 'https://www.twitch.tv',
  ApiUrl = 'https://gql.twitch.tv/gql',
  WssUrl = 'wss://pubsub-edge.twitch.tv/v1',
  SpadeReg = `https://video-edge-[.\\w\\-/]+\\.ts`,
  SettingReg = `https://(static\.twitchcdn\.net|assets\.twitch\.tv)/config/settings\.[0-9a-f]{32}\.js`,
}

export enum WsEvents {
  UserDrop = 'user-drop-events',
  UserPoint = 'community-points-user-v1',
  ChannelMoment = 'community-moments-channel-v1',
  ChannelStream = 'video-playback-by-id',
  ChannelUpdate = 'broadcast-settings-update',
}

export enum DropStatus {
  Active = 'ACTIVE',
  Expired = 'EXPIRED',
  Upcoming = 'UPCOMING',
}

export enum Tasks {
  DropMain = 'dropMain',
  DropOffline = 'dropOffline',
  DropUpcoming = 'dropUpcoming',
}

declare module '@vegapunk/core' {
  type InternalEvents = {
    [K in WsEvents]: [message: ResponseContent];
  };

  interface ClientEvents extends InternalEvents {}
}
