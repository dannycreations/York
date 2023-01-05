import pretty from 'pino-pretty'
import { getTimezoneDate } from './util'
import pino, { Level, StreamEntry } from 'pino'

export const logger = (level?: Level) => {
	level ||= process.env.NODE_ENV === 'development' ? 'trace' : 'info'
	const sync = level === 'trace' ? true : false
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
				sync,
				colorize: true,
				customPrettifiers: {
					time: () => `[${getTimezoneDate().format('HH:mm:ss')}]`
				}
			})
		}
	]

	const logger = pino(
		{
			level,
			base: undefined,
			nestedKey: 'payload'
		},
		pino.multistream(streams)
	)

	return logger
}
