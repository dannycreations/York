import { BetterSqliteDriver, Options } from '@mikro-orm/better-sqlite'
import { TsMorphMetadataProvider } from '@mikro-orm/reflection'
import { SqlHighlighter } from '@mikro-orm/sql-highlighter'
import { join } from 'path'

export function configBetterSqlite(options: Options = {}) {
	return {
		driver: BetterSqliteDriver,
		dbName: 'sqlite.db',
		entities: [join(process.cwd(), 'dist/lib/entities')],
		highlighter: new SqlHighlighter(),
		metadataProvider: TsMorphMetadataProvider,
		allowGlobalContext: true,
		...options,
	}
}
