import { container } from '@sapphire/pieces'
import ws from 'ws'
import { randomString } from '../utils/common.util'
import { Common } from './constants/Enum'
import { Message, Request, RequestType, Response, ResponseType } from './types/WebSocket'

export class WebSocket {
	private _resList: Map<string, Request> = new Map()
	private _reqList: Map<string, Request> = new Map()
	private _timeout: {
		ping?: NodeJS.Timeout
		reconnect?: NodeJS.Timeout
	} = {}

	public async connect(): Promise<void> {
		return new Promise(async (resolve) => {
			try {
				container.logger.trace('WS Connecting')
				container.ev = new ws(Common.WssUrl)
				if (container.stores) {
					const getListeners = container.stores.get('listeners').values()
					await Promise.all([...getListeners].map((store) => store.reload()))
				}

				container.ev.removeAllListeners()
				container.ev.once('open', () => this.onOpen())
				container.ev.once('close', () => this.reconnect())
				container.ev.on('message', (buffer: Buffer) => this.onMessage(buffer))
				container.ev.on('error', (error: Error) => container.logger.error(error, 'at WS onError'))
				this._timeout.reconnect = setTimeout(() => this.reconnect(), 10_000)

				setInterval(() => {
					if (container.ev?.readyState === 1) {
						resolve()
					}
				}, 100)
			} catch (error) {
				container.logger.error(error, 'at WS onConnect')
			}
		})
	}

	public async send(type: RequestType, topic: string): Promise<void> {
		if (this._resList.has(topic) || this._reqList.has(topic)) return

		container.logger.trace(`WS Send: ${type} ${topic}`)
		const payload = {
			type,
			nonce: randomString(),
			data: { topics: [topic], auth_token: process.env.AUTH_TOKEN_MOBILE },
		}

		this._reqList.set(topic, payload)
		await this.sendPromise(payload)
	}

	private async onOpen(): Promise<void> {
		container.logger.trace('WS Connected')
		clearTimeout(this._timeout.reconnect)
		await this.ping()

		const eventList = [...this._resList.values(), ...this._reqList.values()]
		this._resList.clear()
		this._reqList.clear()

		await Promise.all(eventList.map((r) => this.send(r.type, r.data.topics[0])))
	}

	private onMessage(buffer: Buffer): void {
		const response = JSON.parse(buffer.toString()) as Response
		switch (response.type) {
			case ResponseType.Pong:
				clearTimeout(this._timeout.reconnect)
				break
			case ResponseType.Reconnect:
				break
			case ResponseType.Response:
				const reqList = [...this._reqList.values()].find((r) => r.nonce === response.nonce)
				if (!reqList) {
					container.logger.warn(response, 'Unknown websocket response 1')
					break
				}

				const reqEventTopic = reqList.data.topics[0]
				if (reqList.type === RequestType.Listen) {
					this._resList.set(reqEventTopic, reqList)
				} else if (reqList.type === RequestType.Unlisten) {
					this._resList.delete(reqEventTopic)
				}

				this._reqList.delete(reqEventTopic)
				break
			case ResponseType.Message:
				const message = response as unknown as Message
				const resEventTopic = message.data.topic.split('.')[0]
				const resEventMessage = JSON.parse(message.data.message)
				container.ev.emit(resEventTopic, resEventMessage)
				break
			default:
				container.logger.warn(response, 'Unknown websocket message 2')
		}
	}

	private async ping(): Promise<void> {
		// Ping every 4 minutes
		clearTimeout(this._timeout.ping)
		this._timeout.ping = setTimeout(() => this.ping(), 240_000)
		this._timeout.reconnect = setTimeout(() => this.reconnect(), 10_000)
		await this.sendPromise({ type: RequestType.Ping } as Request)
	}

	private reconnect(): void {
		container.logger.trace('WS Reconnect')
		clearTimeout(this._timeout.reconnect)
		this._timeout.reconnect = setTimeout(() => this.connect(), 10_000)
	}

	private async sendPromise(request: Request): Promise<void> {
		return new Promise((resolve) => {
			try {
				const payload = JSON.stringify(request)
				container.ev.send(payload, () => resolve())
			} catch {
				resolve()
			}
		})
	}
}
