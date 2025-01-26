import 'dotenv/config'

import { container } from '@vegapunk/core'
import { YorkClient } from './lib/YorkClient'

const client = new YorkClient()

async function main() {
	try {
		await client.start()
	} catch (error) {
		container.logger.error(error)
		await client.destroy()
		process.exit(1)
	}
}
main().catch(container.logger.error.bind(container.logger))
