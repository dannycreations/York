import 'dotenv/config'

import { container } from '@vegapunk/core'
import { logger } from '@vegapunk/logger'
import { YorkClient } from './lib/YorkClient'

async function bootstrap() {
	container.logger = logger()

	new YorkClient().start()
}
bootstrap()
