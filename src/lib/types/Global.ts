declare global {
	namespace NodeJS {
		interface ProcessEnv {
			readonly AUTH_TOKEN: string
			readonly AUTH_TOKEN_MOBILE: string

			readonly TIMEZONE: string
			readonly NODE_INSPECT: string
			readonly NODE_ENV: 'production' | 'development'
		}
	}
}

export {}
