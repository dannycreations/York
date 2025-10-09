export enum RequestType {
  Ping = 'PING',
  Listen = 'LISTEN',
  Unlisten = 'UNLISTEN',
}

export interface RequestTopic {
  readonly type: RequestType;
  readonly nonce: string;
  readonly data: {
    readonly topics: readonly [string];
    readonly auth_token: string | undefined;
  };
}

export enum ResponseType {
  Pong = 'PONG',
  Response = 'RESPONSE',
  Message = 'MESSAGE',
  Reconnect = 'RECONNECT',
}

export interface ResponseTopic {
  readonly type: ResponseType;
  readonly error: string;
  readonly nonce: string;
}

export interface ResponseMessage extends Omit<ResponseTopic, 'error' | 'nonce'> {
  readonly data: {
    readonly topic: string;
    readonly message: string;
  };
}

export interface ResponseContent<T = string, V = object> {
  readonly topic_id: string;
  readonly type: T;
  readonly data: V;
}
