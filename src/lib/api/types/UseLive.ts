export interface UseLive {
  readonly user: User;
}

export interface User {
  readonly id: string;
  readonly login: string;
  readonly stream: Stream | null;
}

export interface Stream {
  readonly id: string;
  readonly createdAt: string;
}
