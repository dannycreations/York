import userAgent from 'user-agents'
import { defaultsDeep } from 'lodash'
import { Common } from './constants/Enum'
import { container } from '@sapphire/pieces'
import { setTimeout } from 'node:timers/promises'
import { HelixStreams } from './types/HelixStreams'
import { processRestart } from '../utils/replit.util'
import got, { Options, RequestError, Response } from 'got'

export class TwitchApi {
	private options: Options
	private isStateInit?: boolean
	protected authState: {
		spade?: string
		setting?: string
		user_id?: string
		integrity_expires?: number
	} = {}

	public constructor(access_token: string) {
		const ua = new userAgent({ deviceCategory: 'desktop' })
		this.options = {
			method: 'POST',
			prefixUrl: Common.ApiUrl,
			headers: {
				'User-Agent': ua.toString(),
				Authorization: `OAuth ${access_token}`,
			},
			retry: 0,
			timeout: 10_000,
			responseType: 'json',
		}
	}

	public get userID(): string | undefined {
		return this.authState.user_id
	}

	private async request<T>(options: Options): Promise<Response<T> | never> {
		try {
			const res = await got(defaultsDeep({}, options, this.options))
			return res as Response<T>
		} catch (error) {
			//! TODO: Better error handling
			if (error instanceof RequestError) {
				if (error.response?.statusCode === 401) {
					container.logger.fatal(error.response.body, error.message)
					process.exit()
				} else if (error.code === 'ENOTFOUND') {
					await setTimeout(1_000)
					return this.request(options)
				} else if (error.code === 'EAI_AGAIN') {
					await setTimeout(10_000)
					return this.request(options)
				}
			}

			throw error
		}
	}

	public async graphql<T>(options?: Options): Promise<Graphql<T>> {
		if ((await this.stateInit()) === null) processRestart()
		const response = await this.request<Graphql<T>>({ url: 'gql', ...options })
		if (response.body.errors?.length) throw response.body
		return response.body
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
			this.options.headers['Client-Id'] = 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp'

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

		this.isStateInit = true
		return true
	}

	private unique(res: Response<string>) {
		try {
			for (const cookie of res.headers['set-cookie']!) {
				const clean = cookie.match(/(?<=\=)\w+(?=\;)/g)
				if (cookie.startsWith('server_session_id')) {
					this.options.headers['Client-Session-Id'] = clean![0]
				} else if (cookie.startsWith('unique_id') && !cookie.startsWith('unique_id_durable')) {
					this.options.headers['X-Device-Id'] = clean![0]
				}
			}

			const htmlReg = new RegExp('twilightBuildID="([-a-z0-9]+)"')
			this.options.headers['Client-Version'] = htmlReg.exec(res.body)![1]

			return true
		} catch (error) {
			container.logger.error(error, 'Could not fetch your unique')
			return false
		}
	}

	public async watch(stream: ActiveLiveChannel) {
		try {
			if (!this.authState.setting) {
				const twitchHome = await this.home()
				const settingsReg = new RegExp(Common.SettingReg)
				const settingsUrl = settingsReg.exec(twitchHome.body)![0]
				if (!settingsUrl) throw 'Could not parsing Settings Url'
				this.authState.setting = settingsUrl
			}

			const prefixUrl = ''
			const responseType = 'text'

			if (!this.authState.spade) {
				const getSettings = await this.request<string>({ method: 'GET', prefixUrl, url: this.authState.setting, responseType })
				const spadeReg = new RegExp(Common.SpadeReg)
				const spadeUrl = spadeReg.exec(getSettings.body)![0]
				if (!spadeUrl) throw 'Could not parsing Spade Url'
				this.authState.spade = spadeUrl
			}

			const payload = {
				event: 'minute-watched',
				properties: {
					broadcast_id: stream.broadcast_id,
					channel_id: stream.channel_id,
					channel: stream.login,
					hidden: false,
					live: true,
					location: 'channel',
					logged_in: true,
					muted: false,
					player: 'site',
					user_id: this.authState.user_id,
					game: stream.game_name || '',
					game_id: stream.game_id || '',
				},
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

	public async helix(user_id: string) {
		try {
			const prefixUrl = 'https://api.twitch.tv'
			const res = await this.request<HelixStreams>({
				method: 'GET',
				prefixUrl,
				url: 'helix/streams',
				headers: { 'Client-Id': 'uaw3vx1k0ttq74u9b2zfvt768eebh1' },
				searchParams: { user_id },
			})
			return res.body
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
	game_name?: string
	game_id?: string
}
