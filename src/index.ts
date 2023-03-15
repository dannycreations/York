import 'dotenv/config'
import { logger } from './lib/utils/logger'
import { container } from '@sapphire/pieces'
import { YorkClient } from './lib/YorkClient'
import { isReplit, keepAlive, processRestart } from './lib/utils/util'

container.logger = logger()

if (process.env.NODE_INSPECT === 'true' && process.env.NODE_ENV === 'development') {
	// @ts-expect-error
	globalThis.container = container
}

;(async () => {
	if (isReplit()) {
		// Restart process every 6 hours
		setTimeout(() => processRestart(), 2.16e7)
	}

	await keepAlive()

	new YorkClient().start()
})()
