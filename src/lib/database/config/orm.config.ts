import { join } from 'path'
import { Options } from '@mikro-orm/core'

export const ormConfig: Options = {
	type: 'better-sqlite',
	dbName: ':memory:',
	entities: [join(__dirname, '..', 'entities')],
	allowGlobalContext: true,
}
