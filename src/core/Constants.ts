import { Data } from 'effect';

import type { ValueOf } from '@vegapunk/utilities';

export const WsTopic = Data.struct({
  UserDrop: 'user-drop-events',
  UserPoint: 'community-points-user-v1',
  ChannelMoment: 'community-moments-channel-v1',
  ChannelStream: 'video-playback-by-id',
  ChannelUpdate: 'broadcast-settings-update',
} as const);

export type WsTopic = ValueOf<typeof WsTopic>;

export const Twitch = Data.struct({
  WebUrl: 'https://www.twitch.tv',
  ApiUrl: 'https://gql.twitch.tv/gql',
  WssUrl: 'wss://pubsub-edge.twitch.tv/v1',
  SpadeReg: /https:\/\/video-edge-[.\w\-/]+\.ts/,
  SettingReg: /https:\/\/(static\.twitchcdn\.net|assets\.twitch\.tv)\/config\/settings\.[0-9a-f]{32}\.js/,
} as const);
