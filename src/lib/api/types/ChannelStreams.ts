export interface ChannelStreams {
  users: Users[];
}

export interface Users {
  id: string;
  login: string;
  stream: Stream | null;
}

export interface Stream {
  id: string;
  createdAt: string;
}
