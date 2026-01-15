import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { container } from '@vegapunk/core';
import { chalk } from '@vegapunk/utilities';
import { isObjectLike, uniqueId } from '@vegapunk/utilities/common';

export function marker(stage: number | string, ...args: (number | string)[]): void {
  const str = `${stage} ${args.join(' ')}`.trimEnd();
  container.logger.info(chalk`{bold.red ========== STAGE ${str} ==========}`);
}

export async function writeDebugFile(data: string | object, name?: string): Promise<void> {
  if (isObjectLike(data)) {
    data = JSON.stringify(data, null, 2);
  }

  const debugDir = join(process.cwd(), 'debug');
  await access(debugDir).catch(() => mkdir(debugDir, { recursive: true }));
  await writeFile(join(debugDir, `${name || uniqueId(String(Date.now()))}.json`), data);
}
