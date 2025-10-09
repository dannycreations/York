import 'dotenv/config';

import { runApp } from '@vegapunk/utilities';

import { YorkClient } from './lib/YorkClient';

async function main(): Promise<void> {
  const client = new YorkClient();
  try {
    await client.start();
  } catch (error: unknown) {
    console.trace(error);
    await client.destroy();
  }
}

void runApp(main);
