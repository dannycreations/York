import { ClientEvents, container } from '@vegapunk/core'
import { ErrorCodes, waitForConnection } from '@vegapunk/request'
import { randomString } from '@vegapunk/utilities'
import { noop } from '@vegapunk/utilities/common'
import { sleepUntil } from '@vegapunk/utilities/sleep'
import WebSocket from 'ws'
import { Twitch, WsEvents } from '../constants/Enum'
import { Message, MessageData, Request, RequestType, Response, ResponseType } from './types/WebSocket'

const pingDelay = 60_000 * 3 // 3 minutes
const reconnectDelay = 10_000 // 10 seconds

export class WSClient {
	public static readonly IS_DEBUG = true

	public constructor(private readonly auth_token: string) {}

	public get connected(): boolean {
		return !this.session.destroy && !!this.session.connected
	}

	private isConnectOnce?: boolean
	public async connect(): Promise<void> {
		if (this.connected || this.isConnectOnce) return
		this.isConnectOnce = true

		try {
			if (WSClient.IS_DEBUG) container.logger.debug('WS Connecting')

			await waitForConnection()
			this.ws = new WebSocket(Twitch.WssUrl, { handshakeTimeout: reconnectDelay })
			this.ws.once('open', this.onOpen.bind(this))
			this.ws.once('close', this.reconnect.bind(this))
			this.ws.on('error', this.onError.bind(this))
			this.ws.on('message', this.onMessage.bind(this))
			this.timeout.reconnect = setTimeout(this.reconnect.bind(this), reconnectDelay).unref()
			await sleepUntil(() => this.connected || this.ws?.readyState === WebSocket.CLOSED)
		} finally {
			this.isConnectOnce = false
		}
	}

	public destroy(): void {
		this.session.destroy = true
		this.terminate()
	}

	public async listen(topic: RequestTopic): Promise<void> {
		if (this.has(topic)) return

		const topicName = this.parseTopic(topic)
		const payload: RequestData = {
			type: RequestType.Listen,
			nonce: randomString(30),
			data: {
				topics: [topicName],
				auth_token: this.auth_token,
			},
		}
		await this.send(payload)
	}

	public async unlisten(topic: RequestTopic): Promise<void> {
		if (!this.has(topic)) return

		const topicName = this.parseTopic(topic)
		let payload = this.values().find((r) => r.data.topics[0] === topicName)!
		payload.type = RequestType.Unlisten
		payload.data.auth_token = undefined
		await this.send(payload)
	}

	private async onOpen(): Promise<void> {
		clearTimeout(this.timeout.reconnect)

		await this.ping()
		await sleepUntil(() => this.connected || this.ws?.readyState === WebSocket.CLOSED)

		if (!this.connected && this.ws?.readyState !== WebSocket.OPEN) return
		if (WSClient.IS_DEBUG) container.logger.debug('WS Connected')
		if (this.queue.size === 0) return

		const queue = this.values().map(({ success, ...rest }) => rest)
		this.queue.clear()

		await Promise.all(queue.map(this.send.bind(this)))
	}

	private onMessage(buffer: Buffer): void {
		const res = JSON.parse(String(buffer)) as Response
		const msg = res as unknown as Message

		switch (res.type) {
			case ResponseType.Pong:
				this.session.connected = true
				clearTimeout(this.timeout.reconnect)
				break
			case ResponseType.Response:
				this.handleResponse(res)
				break
			case ResponseType.Message:
				this.handleMessage(msg)
				break
			default:
				container.logger.warn(res, 'Unknown websocket response')
		}
	}

	private handleResponse(res: Response): void {
		const queue = this.values().find((r) => r.nonce === res.nonce)
		if (!queue) {
			container.logger.warn(res, 'Unknown websocket response')
			return
		}

		const topicType = queue.type
		const topicKey = queue.data.topics[0]

		if (topicType === RequestType.Listen) {
			this.queue.get(topicKey)!.success = true
		} else if (topicType === RequestType.Unlisten) {
			this.queue.delete(topicKey)
		}

		if (WSClient.IS_DEBUG) container.logger.debug(`WS Response: ${topicType} ${topicKey}`)
	}

	private handleMessage(msg: Message): void {
		if (!msg.data) return

		const [topicName, topicId] = msg.data.topic.split('.')
		const messageData: MessageData = { topic_id: topicId, ...JSON.parse(msg.data.message) }

		container.client.emit(topicName as keyof ClientEvents, messageData)
		if (WSClient.IS_DEBUG) container.logger.debug(messageData, `WS Message: ${topicName}`)
	}

	private onError(error: Error & { code: string }): void {
		if (ErrorCodes.includes(error.code)) return

		error.message = `WS onError: ${error.message}`
		container.logger.error(error)
	}

	private reconnect(): void {
		this.session.connected = false
		this.terminate()
		if (WSClient.IS_DEBUG) container.logger.debug('WS Reconnect')

		this.timeout.reconnect = setTimeout(this.connect.bind(this), reconnectDelay).unref()
	}

	private async ping(): Promise<void> {
		await this.sendPromise({ type: RequestType.Ping })
		if (WSClient.IS_DEBUG) container.logger.debug('WS Ping')

		this.timeout.ping = setTimeout(this.ping.bind(this), pingDelay).unref()
		this.timeout.reconnect = setTimeout(this.reconnect.bind(this), reconnectDelay).unref()
	}

	private terminate(): void {
		if (!this.ws) return

		clearTimeout(this.timeout.ping)
		clearTimeout(this.timeout.reconnect)

		this.ws.removeAllListeners()
		this.ws.once('error', noop)
		this.ws.terminate()
		this.ws = null
	}

	private async send(data: RequestData): Promise<void> {
		const topicKey = data.data.topics[0]
		this.queue.set(topicKey, data)

		await this.sendPromise(data)
		if (WSClient.IS_DEBUG) container.logger.debug(`WS Send: ${data.type} ${topicKey}`)
	}

	private async sendPromise(data: object): Promise<void> {
		return new Promise<void>((resolve) => {
			if (this.ws?.readyState !== WebSocket.OPEN) return resolve()
			this.ws.send(JSON.stringify(data), () => resolve())
		})
	}

	private parseTopic(topic: RequestTopic): string {
		return typeof topic === 'string' ? topic : topic.join('.')
	}

	private has(topic: RequestTopic): boolean {
		const topicName = this.parseTopic(topic)
		return this.values().some((r) => r.data.topics[0] === topicName)
	}

	private values(): RequestData[] {
		return [...this.queue.values()]
	}

	private ws: WebSocket | null = null
	private readonly queue = new Map<string, RequestData>()
	private readonly session: {
		connected?: boolean
		destroy?: boolean
	} = {}
	private readonly timeout: {
		ping?: NodeJS.Timeout
		reconnect?: NodeJS.Timeout
	} = {}
}

type RequestData = Request & { success?: boolean }
type RequestTopic = readonly [`${WsEvents}`, string] | string
