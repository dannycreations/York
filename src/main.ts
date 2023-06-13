import 'dotenv/config'

import { container } from '@sapphire/pieces'
import { YorkClient } from './lib/YorkClient'
import { logger } from './lib/utils/logger.util'
import { MikroORM } from './lib/database/MikroORM'
import { isReplit, processRestart, keepAlive } from './lib/utils/common.util'

if (process.env.NODE_INSPECT === 'true' && process.env.NODE_ENV === 'development') {
	globalThis.container = container
}

async function bootstrap() {
	container.logger = logger()

	if (isReplit()) {
		// Restart process every 6 hours
		setTimeout(() => processRestart(), 2.16e7)
	}

	await Promise.all([keepAlive(), MikroORM()])

	new YorkClient().start()
}
bootstrap()
