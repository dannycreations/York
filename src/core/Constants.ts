import type { ValueOf } from '@vegapunk/utilities';

export const WsTopic = {
  UserDrop: 'user-drop-events',
  UserPoint: 'community-points-user-v1',
  ChannelMoment: 'community-moments-channel-v1',
  ChannelStream: 'video-playback-by-id',
  ChannelUpdate: 'broadcast-settings-update',
  ChannelPoint: 'community-points-channel-v1',
} as const;

export type WsTopic = ValueOf<typeof WsTopic>;

export const Twitch = {
  WebUrl: 'https://www.twitch.tv',
  ApiUrl: 'https://gql.twitch.tv/gql',
  WssUrl: 'wss://pubsub-edge.twitch.tv/v1',
} as const;
