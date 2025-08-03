import 'dotenv/config';

import { YorkClient } from './lib/YorkClient';

const client = new YorkClient();

async function main() {
  try {
    await client.start();
  } catch (error) {
    console.trace(error);
    await client.destroy();
  }
}

main().catch(console.trace);
