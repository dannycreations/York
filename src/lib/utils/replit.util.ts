import { container } from '@sapphire/pieces'
import { execSync } from 'node:child_process'
import { createServer } from 'node:http'

export function isReplit(): boolean {
	return !!process.env.REPL_ID
}

export function processRestart(): void {
	isReplit() ? execSync('kill 1') : process.exit(1)
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
