import pretty from 'pino-pretty'
import { Moment, tz } from 'moment-timezone'
import pino, { Level, StreamEntry } from 'pino'

export const logger = (level?: Level) => {
	level ||= process.env.NODE_ENV === 'development' ? 'trace' : 'info'
	const streams: StreamEntry[] = [
		{
			level: 'warn',
			stream: pino.destination({
				mkdir: true,
				dest: `${process.cwd()}/logs/errors.log`,
			}),
		},
		{
			level,
			stream: pretty({
				sync: true,
				colorize: true,
				customPrettifiers: {
					time: () => `[${getTimezoneDate().format('HH:mm:ss')}]`,
				},
			}),
		},
	]

	return pino(
		{
			level,
			base: undefined,
			nestedKey: 'payload',
		},
		pino.multistream(streams),
	)
}

export function getTimezoneDate(date: Date = new Date(), timezone?: string): Moment {
	return tz(date, timezone || process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone)
}
