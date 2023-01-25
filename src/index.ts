import 'dotenv/config'
import { container } from '@sapphire/pieces'
import { YorkClient } from './lib/YorkClient'
import { keepAlive, processRestart } from './lib/utils/util'

if (process.env.NODE_INSPECT === 'true' && process.env.NODE_ENV === 'development') {
	// @ts-expect-error
	globalThis.container = container
}

// Restart process every 6 hours
setTimeout(() => processRestart(), 2.16e7)

keepAlive()

new YorkClient().start()
