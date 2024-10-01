import { container } from '@vegapunk/core'
import { Options, RequestError, Response, requestDefault } from '@vegapunk/request'
import { _, sleep } from '@vegapunk/utilities'
import { Common } from './constants/Enum'
import { HelixStreams } from './types/HelixStreams'
import { PlaybackAccessToken } from './types/PlaybackAccessToken'

export abstract class TwitchApi {
	public constructor(auth_token: string) {
		this.options = {
			method: 'POST',
			prefixUrl: Common.ApiUrl,
			headers: { authorization: `OAuth ${auth_token}` },
			retry: -1,
			responseType: 'json',
		}
	}

	public get userId(): string | undefined {
		return this.authState.user_id
	}

	public async graphql<T>(options?: Options): Promise<Graphql<T>> {
		if ((await this.stateInit()) === null) process.exit(1)

		const response = await this.request<Graphql<T>>({ url: 'gql', ...options })
		if (response.body.errors?.length) {
			const errorState = ['service error', 'service timeout']
			for (const error of response.body.errors) {
				if (!errorState.includes(error.message)) continue

				container.logger.warn(`${error.path[0]} ${error.message}`)
				await sleep(10_000)
				return this.graphql(options)
			}

			response.body.data = null
			throw response.body
		}
		return response.body
	}

	abstract playbackAccessToken(login: string): Promise<Graphql<PlaybackAccessToken>>

	public async watch(channel: ActiveLiveChannel): Promise<boolean> {
		const stage: number[] = []
		try {
			const prefixUrl = ''
			const responseType = 'text'

			if (typeof channel.broadcast_url !== 'string') {
				stage.push(0)
				const playback = await this.playbackAccessToken(channel.login)
				stage.push(1)
				const broadcast = await this.request<string>({
					method: 'GET',
					prefixUrl: 'https://usher.ttvnw.net',
					url: `api/channel/hls/${channel.login}.m3u8`,
					searchParams: {
						sig: playback.data.streamPlaybackAccessToken.signature,
						token: playback.data.streamPlaybackAccessToken.value,
					},
					responseType,
				})
				channel.broadcast_url = broadcast.body.split('\n').filter(Boolean).at(-1)
				stage.push(2)
			}

			stage.push(3)
			const stream = await this.request<string>({
				method: 'GET',
				prefixUrl,
				url: channel.broadcast_url,
				headers: { connection: 'close' },
				responseType,
			})
			const streamFilter = stream.body.split('\n').filter(Boolean)
			stage.push(4)

			let parseSLQUrl = streamFilter.at(-1)
			if (!!~parseSLQUrl.indexOf('#')) parseSLQUrl = streamFilter.at(-2)
			stage.push(5)

			const watch = await this.request({ method: 'HEAD', prefixUrl, url: parseSLQUrl, responseType })
			stage.push(6)

			return watch.statusCode === 200
		} catch (error) {
			if (error instanceof RequestError) {
				if (error.response.statusCode === 404) {
					channel.broadcast_url = null
					return this.watch(channel)
				}
			}

			error.stage = stage
			container.logger.error(error, 'Could not watch stream')
			return false
		}
	}

	public async stream(user_id: string) {
		try {
			const prefixUrl = 'https://api.twitch.tv'
			const res = await this.request<HelixStreams>({
				method: 'GET',
				prefixUrl,
				url: 'helix/streams',
				headers: { 'client-id': 'uaw3vx1k0ttq74u9b2zfvt768eebh1' },
				searchParams: { user_id },
			})
			return res.body
		} catch (error) {
			container.logger.error(error, 'Could not fetch stream')
			return false
		}
	}

	private async stateInit(): Promise<boolean | null> {
		if (this.isStateInit) return false

		if (!(await this.validate())) return null
		if (!(await this.unique())) return null

		this.isStateInit = true
		return true
	}

	private async validate() {
		try {
			interface Validate {
				user_id: string
				client_id: string
			}

			const prefixUrl = 'https://id.twitch.tv'
			const res = await this.request<Validate>({ method: 'GET', prefixUrl, url: 'oauth2/validate' })

			this.authState.user_id = res.body.user_id
			this.options.headers['client-id'] = 'ue6666qo983tsx6so1t0vnawi233wa'

			return true
		} catch (error) {
			container.logger.error(error, 'Could not validate your auth token')
			return false
		}
	}

	private async unique() {
		try {
			const prefixUrl = 'https://twitch.tv'
			const res = await this.request<string>({ method: 'GET', prefixUrl, responseType: 'text' })

			for (const cookie of res.headers['set-cookie']!) {
				const clean = cookie.match(/(?<=\=)\w+(?=\;)/g)
				if (cookie.startsWith('server_session_id')) {
					this.options.headers['client-session-id'] = clean![0]
				} else if (cookie.startsWith('unique_id') && !cookie.startsWith('unique_id_durable')) {
					this.options.headers['x-device-id'] = clean![0]
				}
			}

			const htmlReg = new RegExp('twilightBuildID="([-a-z0-9]+)"')
			this.options.headers['client-version'] = htmlReg.exec(res.body)[1]

			return true
		} catch (error) {
			container.logger.error(error, 'Could not fetch your unique')
			return false
		}
	}

	private async request<T>(options: Options): Promise<Response<T> | never> {
		try {
			return await requestDefault(_.defaultsDeep({}, options, this.options))
		} catch (error) {
			if (error instanceof RequestError) {
				if (error.response.statusCode === 401) {
					container.logger.fatal(error.response.body, error.message)
					process.exit(0)
				}
			}

			throw error
		}
	}

	protected authState: { user_id?: string } = {}

	private options: Options
	private isStateInit?: boolean
}

export interface Graphql<T = {}> {
	errors?: Array<{
		message: string
		path: string[]
	}>
	data: T
	extensions: {
		durationMilliseconds: number
		operationName: string
		requestID: string
	}
}

export interface ActiveLiveChannel {
	login: string
	channel_id: string
	broadcast_url?: string
}
