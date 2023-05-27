import { createServer } from 'node:http'
import { exec } from 'node:child_process'
import { container } from '@sapphire/pieces'
import { Moment, tz } from 'moment-timezone'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

export function writeDebugFile(data: string | object, name?: string): void {
	if (typeof data === 'object') data = JSON.stringify(data, null, 4)

	const dirDebug = `${process.cwd()}/debug`
	if (!existsSync(dirDebug)) mkdirSync(dirDebug, { recursive: true })

	writeFileSync(`${dirDebug}/${name || Date.now()}.json`, data)
}

export function isReplit(): boolean {
	return !!process.env.REPL_ID
}

export function hasMobileAuth(): boolean {
	return !!process.env.AUTH_TOKEN_MOBILE
}

export function processRestart(): void {
	isReplit() ? exec('kill 1') : process.exit(1)
}

export function keepAlive(): Promise<void> {
	return new Promise((resolve) => {
		if (!isReplit()) return resolve()

		const port = process.env.PORT || 0
		const server = createServer((req, res) => {
			if (req.url === '/' && req.method === 'GET') {
				res.writeHead(200)
				res.end("I'm alive")
			} else {
				res.writeHead(404)
				res.end(`Cannot ${req.method} ${req.url}`)
			}
		})
		server.listen(port, () => {
			container.logger.info(`App listening on port ${port}`)
			resolve()
		})
	})
}

export function getTimezoneDate(date: Date = new Date(), timezone?: string): Moment {
	return tz(date, timezone || process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone)
}
