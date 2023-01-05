import 'dotenv/config'
import { YorkClient } from './lib/YorkClient'
import { keepAlive, processRestart } from './lib/utils/util'

// Restart process every 6 hours
setTimeout(() => processRestart(), 2.16e7)

keepAlive()

new YorkClient().start()
