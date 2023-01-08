import ws from 'ws'
import { Constants } from '../types/Enum'
import { container } from '@sapphire/pieces'
import { Message, Request, RequestType, Response, ResponseType } from '../types/twitch/WebSocket'

export class WebSocket {
	private _resList: Map<string, Request> = new Map()
	private _reqList: Map<string, Request> = new Map()
	private _timeout: {
		ping?: NodeJS.Timeout
		reconnect?: NodeJS.Timeout
	} = {}

	public async connect(): Promise<void> {
		container.logger.debug('WS Connecting')

		container.ev = new ws(Constants.WssUrl)
		if (container.stores) {
			const getListeners = container.stores.get('listeners').values()
			await Promise.all([...getListeners].map((store) => store.reload()))
		}

		container.ev.once('open', this.onOpen.bind(this))
		container.ev.once('close', this.reconnect.bind(this))
		container.ev.on('message', this.onMessage.bind(this))
		this._timeout.reconnect = setTimeout(this.reconnect.bind(this), 1e4)
	}

	public async send(type: RequestType, topic: string): Promise<void> {
		if (this._resList.has(topic) || this._reqList.has(topic)) return

		const payload = {
			type,
			nonce: container.client.randomString(),
			data: { topics: [topic], auth_token: process.env.AUTH_TOKEN }
		}

		this._reqList.set(topic, payload)
		return this.sendPromise(payload).catch()
	}

	private async onOpen(): Promise<void> {
		container.logger.debug('WS Connected')

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
			case ResponseType.Response:
				const reqList = [...this._reqList.values()].find((r) => r.nonce === response.nonce)
				if (!reqList) {
					container.logger.warn(response, 'Unknown websocket message')
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
				container.logger.warn(response, 'Unknown websocket message')
		}
	}

	private async ping(): Promise<void> {
		container.logger.debug('WS Ping')

		clearTimeout(this._timeout.ping)
		this._timeout.ping = setTimeout(this.ping.bind(this), 24e4)
		this._timeout.reconnect = setTimeout(this.reconnect.bind(this), 1e4)
		return this.sendPromise({ type: RequestType.Ping } as Request).catch()
	}

	private reconnect(): void {
		container.logger.debug('WS Reconnect')

		container.ev.removeAllListeners()
		clearTimeout(this._timeout.reconnect)
		this._timeout.reconnect = setTimeout(this.connect.bind(this), 1e4)
	}

	private async sendPromise(request: Request): Promise<void> {
		return new Promise((resolve, reject) => {
			try {
				const payload = JSON.stringify(request)
				container.ev.send(payload, () => resolve())
			} catch (error) {
				reject(error)
			}
		})
	}
}
