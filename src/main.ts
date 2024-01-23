import 'dotenv/config'

import { container } from '@sapphire/pieces'
import { YorkClient } from './lib/YorkClient'
import { MikroORM } from './lib/database/MikroORM'
import { logger } from './lib/utils/logger.util'

if (process.env.NODE_INSPECT === 'true' && process.env.NODE_ENV === 'development') {
	globalThis.container = container
}

async function bootstrap() {
	container.logger = logger()

	await MikroORM()
	new YorkClient().start()
}
bootstrap()
