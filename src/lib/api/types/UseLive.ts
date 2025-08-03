export interface UseLive {
  user: User;
}

export interface User {
  id: string;
  login: string;
  stream: Stream | null;
}

export interface Stream {
  id: string;
  createdAt: string;
}
