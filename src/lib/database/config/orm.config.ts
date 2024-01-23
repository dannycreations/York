import { BetterSqliteDriver, Options } from '@mikro-orm/better-sqlite'
import { TsMorphMetadataProvider } from '@mikro-orm/reflection'
import { SqlHighlighter } from '@mikro-orm/sql-highlighter'
import { join } from 'path'

export const ormConfig: Options = {
	driver: BetterSqliteDriver,
	dbName: 'sqlite.db',
	entities: [join(__dirname, '..', 'entities')],
	highlighter: new SqlHighlighter(),
	metadataProvider: TsMorphMetadataProvider,
	allowGlobalContext: true,
}
