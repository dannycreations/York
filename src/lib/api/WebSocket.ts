import { container } from '@vegapunk/core'
import { randomString } from '@vegapunk/utilities'
import ws from 'ws'
import { Common } from './constants/Enum'
import { Message, Request, RequestType, Response, ResponseType } from './types/WebSocket'

export class WebSocket {
	public static Instance = new WebSocket()

	public async connect() {
		return new Promise(async (resolve) => {
			try {
				container.logger.trace('WS Connecting')
				this._ev = new ws(Common.WssUrl)
				if (container.stores) {
					const getListeners = container.stores.get('listeners').values()
					await Promise.all([...getListeners].map((store) => store.reload()))
				}

				this._ev.removeAllListeners()
				this._ev.once('open', () => this.onOpen())
				this._ev.once('close', () => this.reconnect())
				this._ev.on('message', (buffer: Buffer) => this.onMessage(buffer))
				this._ev.on('error', (error: Error) => container.logger.error(error, 'at WS onError'))
				this._timeout.reconnect = setTimeout(() => this.reconnect(), 10_000)

				setInterval(() => {
					if (this._ev?.readyState === 1) {
						resolve(true)
					}
				}, 100)
			} catch (error) {
				container.logger.error(error, 'at WS onConnect')
			}
		})
	}

	public async send(type: RequestType, topic: string) {
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

	private async onOpen() {
		container.logger.trace('WS Connected')
		clearTimeout(this._timeout.reconnect)
		await this.ping()

		const eventList = [...this._resList.values(), ...this._reqList.values()]
		this._resList.clear()
		this._reqList.clear()

		await Promise.all(eventList.map((r) => this.send(r.type, r.data.topics[0])))
	}

	private onMessage(buffer: Buffer) {
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
				container.client.emit(resEventTopic, resEventMessage)
				break
			default:
				container.logger.warn(response, 'Unknown websocket message 2')
		}
	}

	private async ping() {
		// Ping every 4 minutes
		clearTimeout(this._timeout.ping)
		this._timeout.ping = setTimeout(() => this.ping(), 240_000)
		this._timeout.reconnect = setTimeout(() => this.reconnect(), 10_000)
		await this.sendPromise({ type: RequestType.Ping } as Request)
	}

	private reconnect() {
		container.logger.trace('WS Reconnect')
		clearTimeout(this._timeout.reconnect)
		this._timeout.reconnect = setTimeout(() => this.connect(), 10_000)
	}

	private async sendPromise(request: Request) {
		return new Promise((resolve) => {
			try {
				const payload = JSON.stringify(request)
				this._ev.send(payload, () => resolve(true))
			} catch {
				resolve(false)
			}
		})
	}

	private _ev: ws
	private _resList: Map<string, Request> = new Map()
	private _reqList: Map<string, Request> = new Map()
	private _timeout: {
		ping?: NodeJS.Timeout
		reconnect?: NodeJS.Timeout
	} = {}
}
