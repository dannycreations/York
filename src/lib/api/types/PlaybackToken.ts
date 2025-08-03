export interface PlaybackToken {
  streamPlaybackAccessToken: StreamPlaybackAccessToken;
}

export interface StreamPlaybackAccessToken {
  value: string;
  signature: string;
  authorization: Authorization;
}

export interface Authorization {
  isForbidden: boolean;
  forbiddenReasonCode: string;
}
