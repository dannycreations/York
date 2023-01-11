import pretty from 'pino-pretty'
import { getTimezoneDate } from './util'
import pino, { Level, StreamEntry } from 'pino'

export const logger = (level?: Level) => {
	level ||= process.env.NODE_ENV === 'development' ? 'trace' : 'info'
	const streams: StreamEntry[] = [
		{
			level: 'warn',
			stream: pino.destination({
				mkdir: true,
				dest: `${process.cwd()}/logs/errors.log`
			})
		},
		{
			level,
			stream: pretty({
				sync: level === 'trace',
				colorize: true,
				customPrettifiers: {
					time: () => `[${getTimezoneDate().format('HH:mm:ss')}]`
				}
			})
		}
	]

	return pino(
		{
			level,
			base: undefined,
			nestedKey: 'payload'
		},
		pino.multistream(streams)
	)
}
