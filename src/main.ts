import 'dotenv/config'

import { logger } from './lib/utils/logger'
import { container } from '@sapphire/pieces'
import { YorkClient } from './lib/YorkClient'
import { isReplit, keepAlive, processRestart } from './lib/utils/util'

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
