export interface CurrentDrops {
  readonly currentUser: CurrentUser;
}

export interface CurrentUser {
  readonly id: string;
  readonly dropCurrentSession: DropCurrentSession | null;
}

export interface DropCurrentSession {
  readonly channel: Channel | null;
  readonly game: Omit<Channel, 'name'> | null;
  readonly currentMinutesWatched: number;
  readonly requiredMinutesWatched: number;
  readonly dropID: string;
}

export interface Channel {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}
