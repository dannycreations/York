export interface ChannelStreams {
  readonly users: readonly Users[];
}

export interface Users {
  readonly id: string;
  readonly login: string;
  readonly stream: Stream | null;
}

export interface Stream {
  readonly id: string;
  readonly createdAt: string;
}
