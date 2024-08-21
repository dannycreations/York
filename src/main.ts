import 'dotenv/config'

import { container } from '@vegapunk/core'
import { MikroORM, configBetterSqlite } from '@vegapunk/mikro-orm'
import { YorkClient } from './lib/YorkClient'

const client = new YorkClient()

async function main() {
	try {
		await MikroORM(configBetterSqlite())
		await client.start()
	} catch (error) {
		container.logger.error(error)
		process.exit(1)
	}
}
main().catch(container.logger.error.bind(container.logger))
