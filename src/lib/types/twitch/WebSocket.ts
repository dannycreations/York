export enum RequestType {
	Ping = 'PING',
	Listen = 'LISTEN',
	Unlisten = 'UNLISTEN'
}

export interface Request {
	type: RequestType
	nonce: string
	data: {
		topics: string[]
		auth_token: string
	}
}

export enum ResponseType {
	Pong = 'PONG',
	Response = 'RESPONSE',
	Message = 'MESSAGE'
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

export interface UserDropEvents {
	type: string
	data: {
		drop_id: string
		channel_id: string
		current_progress_min: number
		required_progress_min: number
	}
}
