import { container } from '@vegapunk/core'
import { ErrorCodes } from '@vegapunk/request'
import { randomString } from '@vegapunk/utilities'
import ws from 'ws'
import { Common } from './constants/Enum'
import { Message, Request, RequestType, Response, ResponseType } from './types/WebSocket'

export class WebSocket {
	public ev?: ws

	public async connect(): Promise<void> {
		return new Promise(async (resolve) => {
			try {
				container.logger.trace('WS Connecting')
				if (this.ev) this.ev.removeAllListeners()

				this.ev = new ws(Common.WssUrl)
				this.ev.once('open', () => this.onOpen())
				this.ev.once('close', () => this.reconnect())
				this.ev.on('message', (buffer: Buffer) => this.onMessage(buffer))
				this.ev.on('error', (error: ErrorCode) => this.onError(error))
				this.timeoutState.reconnect = setTimeout(() => this.reconnect(), 10_000)

				const wait = setInterval(() => {
					if (this.ev?.readyState === 1) {
						clearInterval(wait)
						resolve()
					}
				}, 100)
			} catch (error) {
				container.logger.error(error, 'at WS connect')
			}
		})
	}

	public async send(type: RequestType, topic: string): Promise<void> {
		if (this.resPool.has(topic) || this.reqPool.has(topic)) return

		container.logger.trace(`WS Send: ${type} ${topic}`)
		const payload = {
			type,
			nonce: randomString(),
			data: { topics: [topic], auth_token: process.env.AUTH_TOKEN },
		}

		this.reqPool.set(topic, payload)
		await this.sendPromise(payload)
	}

	private async onOpen(): Promise<void> {
		container.logger.trace('WS Connected')
		clearTimeout(this.timeoutState.reconnect)
		await this.ping()

		const eventList = [...this.resPool.values(), ...this.reqPool.values()]
		this.resPool.clear()
		this.reqPool.clear()

		await Promise.all(eventList.map((r) => this.send(r.type, r.data.topics[0])))
	}

	private onMessage(buffer: Buffer): void {
		const response = JSON.parse(buffer.toString()) as Response
		const message = response as unknown as Message

		switch (response.type) {
			case ResponseType.Pong:
				clearTimeout(this.timeoutState.reconnect)
				break
			case ResponseType.Reconnect:
				break
			case ResponseType.Response:
				if (message.data === undefined) break

				const reqList = [...this.reqPool.values()].find((r) => r.nonce === response.nonce)
				if (!reqList) {
					container.logger.warn(response, 'Unknown websocket response 1')
					break
				}

				const reqEventTopic = reqList.data.topics[0]
				if (reqList.type === RequestType.Listen) {
					this.resPool.set(reqEventTopic, reqList)
				} else if (reqList.type === RequestType.Unlisten) {
					this.resPool.delete(reqEventTopic)
				}

				this.reqPool.delete(reqEventTopic)
				break
			case ResponseType.Message:
				const resEventTopic = message.data.topic.split('.')[0]
				const resEventMessage = JSON.parse(message.data.message)
				container.client.emit(resEventTopic, resEventMessage)
				break
			default:
				container.logger.warn(response, 'Unknown websocket message 2')
		}
	}

	private onError(error: ErrorCode): void {
		if (ErrorCodes.includes(error.code)) return

		container.logger.error(error, 'at WS onError')
	}

	private async ping(): Promise<void> {
		clearTimeout(this.timeoutState.ping)
		this.timeoutState.ping = setTimeout(() => this.ping(), 60_000 * 4)
		this.timeoutState.reconnect = setTimeout(() => this.reconnect(), 10_000)
		await this.sendPromise({ type: RequestType.Ping } as Request)
	}

	private reconnect(): void {
		container.logger.trace('WS Reconnect')
		clearTimeout(this.timeoutState.reconnect)
		this.timeoutState.reconnect = setTimeout(() => this.connect(), 10_000)
	}

	private async sendPromise(request: Request): Promise<void> {
		return new Promise((resolve) => {
			try {
				const payload = JSON.stringify(request)
				this.ev.send(payload, () => resolve())
			} catch {
				resolve()
			}
		})
	}

	private reqPool: Map<string, Request> = new Map()
	private resPool: Map<string, Request> = new Map()
	private timeoutState: {
		ping?: NodeJS.Timeout
		reconnect?: NodeJS.Timeout
	} = {}
}

interface ErrorCode extends Error {
	code: string
}
