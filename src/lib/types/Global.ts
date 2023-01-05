declare global {
	namespace NodeJS {
		interface ProcessEnv {
			readonly TIMEZONE: string
			readonly AUTH_TOKEN: string
			readonly AUTH_TOKEN_MOBILE: string
			readonly NODE_ENV: 'production' | 'development'
		}
	}
}

export {}
