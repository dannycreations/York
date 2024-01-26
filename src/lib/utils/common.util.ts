import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

export function writeDebugFile(data: string | object, name?: string): void {
	if (typeof data === 'object') data = JSON.stringify(data, null, 4)

	const dirDebug = `${process.cwd()}/debug`
	if (!existsSync(dirDebug)) mkdirSync(dirDebug, { recursive: true })

	writeFileSync(`${dirDebug}/${name || Date.now()}.json`, data)
}

export function hasMobileAuth(): boolean {
	return !!process.env.AUTH_TOKEN_MOBILE
}
