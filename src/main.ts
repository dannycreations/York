import 'dotenv/config'

import { container } from '@sapphire/pieces'
import { YorkClient } from './lib/YorkClient'
import { logger } from './lib/utils/logger.util'
import { isReplit, processRestart, keepAlive } from './lib/utils/replit.util'

async function bootstrap() {
	container.logger = logger()

	if (isReplit()) {
		// Restart process every 6 hours
		setTimeout(() => processRestart(), 2.16e7)
	}

	await keepAlive()
	new YorkClient().start()
}
bootstrap()
