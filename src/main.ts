import 'dotenv/config'

import { container } from '@vegapunk/core'
import { logger } from '@vegapunk/logger'
import { MikroORM, configBetterSqlite } from '@vegapunk/mikro-orm'
import { YorkClient } from './lib/YorkClient'

if (process.env.NODE_INSPECT === 'true' && process.env.NODE_ENV === 'development') {
	globalThis.container = container
}

async function bootstrap() {
	container.logger = logger()

	await MikroORM(configBetterSqlite())
	new YorkClient().start()
}
bootstrap()
