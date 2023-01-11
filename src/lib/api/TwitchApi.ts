import delay from 'delay'
import userAgent from 'user-agents'
import { QueryStore } from './QueryStore'
import { Constants } from '../types/Enum'
import { container } from '@sapphire/pieces'
import { processRestart } from '../utils/util'
import got, { Options, RequestError, Response } from 'got'

export class TwitchApi extends QueryStore {
	private options: Options
	private isStateInit?: boolean
	protected authState: {
		spade?: string
		setting?: string
		user_id?: string
		integrity_expires?: number
	} = {}

	public constructor(access_token: string) {
		super()
		const ua = new userAgent({ deviceCategory: 'desktop' })
		this.options = {
			method: 'POST',
			prefixUrl: Constants.ApiUrl,
			headers: {
				'User-Agent': ua.toString(),
				Authorization: `OAuth ${access_token}`
			},
			timeout: 6e4,
			retry: {
				limit: 3,
				maxRetryAfter: 6e4
			},
			responseType: 'json'
		}
	}

	public get userID(): string | undefined {
		return this.authState.user_id
	}

	private async request<T>(options: Options): Promise<Response<T> | never> {
		try {
			const res = await got({ ...this.options, ...options })
			return res as Response<T>
		} catch (error) {
			//! TODO: Better error handling
			if (error instanceof RequestError) {
				if (error.response?.statusCode === 401) {
					container.logger.fatal(error.response.body, error.message)
					process.exit()
				} else if (error.code === 'ENOTFOUND') {
					await delay(1e3)
					return this.request(options)
				} else if (error.code === 'EAI_AGAIN') {
					await delay(1e4)
					return this.request(options)
				}
			}

			throw error
		}
	}

	public async graphql<T>(options?: Options): Promise<Graphql<T>[]> {
		if ((await this.stateInit()) === null) processRestart()
		// if (Date.now() >= this.authState.integrity_expires!) await this.integrity()

		const request = []
		while (super.hasNext()) {
			request.push(this.request<Graphql<T>[]>({ url: 'gql', body: super.next(), ...options }))
		}

		const response = await Promise.all(request)
		return [...response.flatMap((r) => r.body)]
	}

	private async home() {
		const prefixUrl = 'https://twitch.tv'
		return this.request<string>({ method: 'GET', prefixUrl, responseType: 'text' })
	}

	private async validate(): Promise<boolean> {
		try {
			interface Validate {
				user_id: string
				client_id: string
			}

			const prefixUrl = 'https://id.twitch.tv'
			const res = await this.request<Validate>({ method: 'GET', prefixUrl, url: 'oauth2/validate' })

			this.authState.user_id = res.body.user_id
			this.options.headers!['Client-Id'] = res.body.client_id

			return true
		} catch (error) {
			container.logger.error(error, 'Could not validate your auth token')
			return false
		}
	}

	private async stateInit(): Promise<boolean | null> {
		if (this.isStateInit) return false

		if (!(await this.validate())) return null

		const twitchHome = await this.home()
		if (!this.unique(twitchHome)) return null

		// if (!(await this.integrity())) return null

		this.isStateInit = true
		return true
	}

	private unique(res: Response<string>) {
		try {
			for (const cookie of res.headers['set-cookie']!) {
				const clean = cookie.match(/(?<=\=)\w+(?=\;)/g)
				if (cookie.startsWith('server_session_id')) {
					this.options.headers!['Client-Session-Id'] = clean![0]
				} else if (cookie.startsWith('unique_id') && !cookie.startsWith('unique_id_durable')) {
					this.options.headers!['X-Device-Id'] = clean![0]
				}
			}

			const htmlReg = new RegExp('twilightBuildID="([-a-z0-9]+)"')
			this.options.headers!['Client-Version'] = htmlReg.exec(res.body)![1]

			return true
		} catch (error) {
			container.logger.error(error, 'Could not fetch your unique')
			return false
		}
	}

	/**
	 * ! TODO: Bypass x-kpsdk-cd & x-kpsdk-ct
	 * @note force skip for now
	 */
	private async integrity() {
		this.authState.integrity_expires ??= 0
		if (!this.authState.integrity_expires) return true

		try {
			interface Integrity {
				token: string
				expiration: number
				integrity_token: string
			}

			const res = await this.request<Integrity>({ url: 'integrity' })

			this.authState.integrity_expires = res.body.expiration
			this.options.headers!['Client-Integrity'] = res.body.token
			this.options.headers!['Client-Request-Id'] = ''

			return true
		} catch (error) {
			container.logger.error(error, 'Could not fetch your integrity')
			return false
		}
	}

	public async watch({ channel_id, broadcast_id }: ActiveLiveChannel) {
		try {
			if (!this.authState.setting) {
				const twitchHome = await this.home()
				const settingsReg = new RegExp(Constants.SettingReg)
				const settingsUrl = settingsReg.exec(twitchHome.body)![0]
				if (!settingsUrl) throw 'Could not parsing Settings Url'
				this.authState.setting = settingsUrl
			}

			const prefixUrl = undefined
			const responseType = 'text'

			if (!this.authState.spade) {
				const getSettings = await this.request<string>({ method: 'GET', prefixUrl, url: this.authState.setting, responseType })
				const spadeReg = new RegExp(Constants.SpadeReg)
				const spadeUrl = spadeReg.exec(getSettings.body)![0]
				if (!spadeUrl) throw 'Could not parsing Spade Url'
				this.authState.spade = spadeUrl
			}

			const payload = {
				event: 'minute-watched',
				properties: {
					channel_id,
					broadcast_id,
					player: 'site',
					user_id: this.authState.user_id
				}
			}

			const json_event = JSON.stringify([payload])
			const base64_event = Buffer.from(json_event).toString('base64')
			await this.request({ prefixUrl, url: this.authState.spade, body: base64_event, responseType })

			return true
		} catch (error) {
			container.logger.error(error)
			return false
		}
	}
}

export interface Graphql<T = {}> {
	errors?: Error[]
	data: T
	extensions: {
		durationMilliseconds: number
		operationName: string
		requestID: string
	}
}

interface Error {
	message: string
	path: string[]
}

export interface ActiveLiveChannel {
	login: string
	channel_id: string
	broadcast_id: string
}
