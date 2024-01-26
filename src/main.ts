import 'dotenv/config'

import { logger } from '@dnycts/logger'
import { MikroORM, configBetterSqlite } from '@dnycts/mikro-orm'
import { container } from '@dnycts/shaka'
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
