export interface CurrentDrops {
  currentUser: CurrentUser;
}

export interface CurrentUser {
  id: string;
  dropCurrentSession: DropCurrentSession | null;
}

export interface DropCurrentSession {
  channel: Channel | null;
  game: Omit<Channel, 'name'> | null;
  currentMinutesWatched: number;
  requiredMinutesWatched: number;
  dropID: string;
}

export interface Channel {
  id: string;
  name: string;
  displayName: string;
}
