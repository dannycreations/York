export enum RequestType {
  Ping = 'PING',
  Listen = 'LISTEN',
  Unlisten = 'UNLISTEN',
}

export interface RequestTopic {
  type: RequestType;
  nonce: string;
  data: {
    topics: [string];
    auth_token: string | undefined;
  };
}

export enum ResponseType {
  Pong = 'PONG',
  Response = 'RESPONSE',
  Message = 'MESSAGE',
  Reconnect = 'RECONNECT',
}

export interface ResponseTopic {
  type: ResponseType;
  error: string;
  nonce: string;
}

export interface ResponseMessage extends Omit<ResponseTopic, 'error' | 'nonce'> {
  data: {
    topic: string;
    message: string;
  };
}

export interface ResponseContent<T = string, V = object> {
  topic_id: string;
  type: T;
  data: V;
}
