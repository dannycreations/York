import { customAlphabet } from 'nanoid'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'

export function writeDebugFile(data: string | object, name?: string): void {
	if (typeof data === 'object') data = JSON.stringify(data, null, 4)

	const dirDebug = `${process.cwd()}/debug`
	if (!existsSync(dirDebug)) mkdirSync(dirDebug, { recursive: true })

	writeFileSync(`${dirDebug}/${name || Date.now()}.json`, data)
}

export function randomString(length: number = 30, str?: string) {
	const asciiDigits = '0123456789'
	const asciiLowers = 'abcdefghijklmnopqrstuvwxyz'
	const asciiUppers = asciiLowers.toUpperCase()
	str ||= asciiLowers + asciiUppers + asciiDigits
	return customAlphabet(str, length)()
}
