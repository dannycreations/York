export enum RequestType {
	Ping = 'PING',
	Listen = 'LISTEN',
	Unlisten = 'UNLISTEN',
}

export interface Request {
	type: RequestType
	nonce: string
	data: {
		topics: [string]
		auth_token: string | undefined
	}
}

export enum ResponseType {
	Pong = 'PONG',
	Response = 'RESPONSE',
	Message = 'MESSAGE',
	Reconnect = 'RECONNECT',
}

export interface Response {
	type: ResponseType
	error: string
	nonce: string
}

export interface Message extends Omit<Response, 'error' | 'nonce'> {
	data: {
		topic: string
		message: string
	}
}

export interface MessageData<T = string, V = object> {
	topic_id: string
	type: T
	data: V
}
