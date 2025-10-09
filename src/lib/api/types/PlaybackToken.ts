export interface PlaybackToken {
  readonly streamPlaybackAccessToken: StreamPlaybackAccessToken;
}

export interface StreamPlaybackAccessToken {
  readonly value: string;
  readonly signature: string;
  readonly authorization: Authorization;
}

export interface Authorization {
  readonly isForbidden: boolean;
  readonly forbiddenReasonCode: string;
}
