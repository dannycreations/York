import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

export function writeDebugFile(data: string | object, name?: string) {
	if (typeof data === 'object') data = JSON.stringify(data, null, 4)

	const dirDebug = `${process.cwd()}/debug`
	if (!existsSync(dirDebug)) mkdirSync(dirDebug, { recursive: true })

	writeFileSync(`${dirDebug}/${name || Date.now()}.json`, data)
}
