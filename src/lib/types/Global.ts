declare global {
	namespace NodeJS {
		interface ProcessEnv {
			readonly TIMEZONE: string
			readonly NODE_INSPECT: string
			readonly NODE_ENV: 'production' | 'development'

			readonly AUTH_TOKEN: string
			readonly AUTH_TOKEN_MOBILE: string
		}
	}
}

export {}
