import { container } from '@vegapunk/core'
import { DefaultOptions, requestDefault, RequestError, Response, UserAgent } from '@vegapunk/request'
import { defaultsDeep, OnlyOneRequired, truncate } from '@vegapunk/utilities'
import { isObjectLike } from '@vegapunk/utilities/common'
import { Result } from '@vegapunk/utilities/result'
import { sleep, sleepUntil } from '@vegapunk/utilities/sleep'
import { Twitch } from '../constants/Enum'
import { writeDebugFile } from '../utils/dev.util'

const userAgent = new UserAgent({ deviceCategory: 'mobile' })

export class TwitchApi {
	public static readonly IS_DEBUG = false

	public constructor(auth_token: string) {
		this.options = {
			method: 'GET',
			headers: {
				'user-agent': String(userAgent),
				authorization: `OAuth ${auth_token}`,
				'client-id': 'kd1unb4b3q4t58fwlpcbzcbnm76a8fp',
			},
			retry: -1,
			responseType: 'text',
		}
	}

	public get userId(): string | undefined {
		return this.auth.userId
	}

	public async init(): Promise<void> {
		await this.unique()
		await this.validate()
	}

	private readonly gqlBackoffMul = 2
	private readonly gqlMaxRetries = 5
	private readonly gqlErrorRetry = ['service unavailable', 'service timeout', 'context deadline exceeded']
	public async graphql<T>(request: GraphqlRequest | GraphqlRequest[]): Promise<GraphqlResponse<T>[]> {
		if (!this.userId) await sleepUntil(() => !!this.userId)

		const args = Array.isArray(request) ? request : [request]
		const options: DefaultOptions = {
			method: 'POST',
			url: Twitch.ApiUrl,
			body: JSON.stringify(
				args.map((r) => ({
					operationName: r.operationName,
					variables: r.variables,
					query: r.query ?? undefined,
					extensions: r.hash
						? {
								persistedQuery: {
									version: 1,
									sha256Hash: r.hash,
								},
						  }
						: undefined,
				})),
			),
			responseType: 'json',
		}

		return new Promise((resolve, reject) => {
			return sleepUntil(
				async (cancel, retry) => {
					const res = await this.request<GraphqlResponse<T>[]>(options)
					if (res.body.some((r) => r.errors)) {
						const errors = res.body.filter((r) => r.errors).flatMap((r) => r.errors!)
						const retries = errors.filter((r) => this.gqlErrorRetry.includes(r.message))
						if (retries.length) {
							container.logger.warn(retries, `Graphql response has ${retries.length} errors`)
							if (retry >= this.gqlMaxRetries) {
								cancel(), reject(new Error('Max graphql retries exceeded'))
								return
							}

							await sleep(Math.pow(this.gqlBackoffMul, retry) * 1_000)
							return
						}

						const error = new Error('Unknown errors')
						cancel(), reject(Object.assign(error, { cause: errors }))
					}
					cancel(), resolve(res.body)
				},
				{ delay: 0 },
			)
		})
	}

	public async request<T = string>(options: DefaultOptions): Promise<Response<T>> {
		return new Promise(async (resolve, reject) => {
			const run = await Result.fromAsync<Response<T>, RequestError>(() => {
				options = defaultsDeep({}, options, this.options)
				return requestDefault(options as DefaultOptions)
			})
			const result = run.match({
				ok: (res) => (resolve(res), res),
				err: (error) => {
					if (isObjectLike(error.response)) {
						if (error.response.statusCode === 401) {
							container.logger.fatal(error.response.body, error.message)
							process.exit(0)
						}

						reject(error)
						return error.response as Response<T>
					}

					reject(error)
					return null
				},
			})
			if (TwitchApi.IS_DEBUG && result?.statusCode) {
				const status = result.statusCode
				const method = result.request.options.method
				const url = `${status} ${method} ${result.url}`
				await writeDebugFile({
					request: {
						url,
						headers: result.request.options.headers,
						body: result.request.options.body,
					},
					response: { headers: result.headers, body: result.body },
				})

				container.logger.debug(`API: ${truncate(url)}`)
			}
		})
	}

	private async unique() {
		try {
			const { headers, body } = await this.request({
				url: Twitch.WebUrl,
				headers: { accept: 'text/html' },
			})

			for (const cookie of headers['set-cookie']!) {
				const clean = cookie.match(/(?<=\=)\w+(?=\;)/g)
				if (cookie.startsWith('server_session_id')) {
					this.options.headers!['client-session-id'] = clean![0]
				} else if (cookie.startsWith('unique_id') && !cookie.startsWith('unique_id_durable')) {
					this.options.headers!['x-device-id'] = clean![0]
				}
			}

			const htmlReg = new RegExp('twilightBuildID="([-a-z0-9]+)"')
			this.options.headers!['client-version'] = htmlReg.exec(body)![1]
		} catch (error) {
			container.logger.error(error, 'Could not fetch your unique')
			process.exit(1)
		}
	}

	private async validate() {
		try {
			const { body } = await this.request<{ user_id: string }>({
				url: 'https://id.twitch.tv/oauth2/validate',
				responseType: 'json',
			})

			this.auth.userId = body.user_id
		} catch (error) {
			container.logger.error(error, 'Could not validate your auth token')
			process.exit(1)
		}
	}

	private readonly options: DefaultOptions
	private readonly auth: { userId?: string } = {}
}

export type GraphqlRequest<T = object> = OnlyOneRequired<
	{
		operationName: string
		query: string
		hash: string
		variables: T
	},
	'query' | 'hash'
>

export interface GraphqlResponse<T = object> {
	errors?: GraphqlError[]
	data: T
	extensions: {
		durationMilliseconds: number
		operationName: string
		requestID: string
	}
}

export interface GraphqlError {
	message: string
	path: string[]
}
