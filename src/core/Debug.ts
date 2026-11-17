import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isObjectLike } from '@vegapunk/utilities/common';
import { Context, Effect, Layer } from 'effect';

export interface DebugClient {
  readonly isEnabled: boolean;
  readonly write: (data: string | object, name?: string, force?: boolean) => Effect.Effect<void>;
}

export class DebugTag extends Context.Service<DebugTag, DebugClient>()('@core/Debug') {}

export const DebugLayer = (isEnabled: boolean): Layer.Layer<DebugTag> =>
  Layer.succeed(DebugTag, {
    isEnabled,
    write: (data, name, force = false) => {
      if (!isEnabled && !force) {
        return Effect.void;
      }

      const content = isObjectLike(data) ? JSON.stringify(data, null, 2) : data;

      return Effect.tryPromise(async () => {
        const debugDir = join(process.cwd(), 'debug');
        const fileName = name ? `${name}.json` : `${Date.now()}.json`;
        await mkdir(debugDir, { recursive: true });
        await writeFile(join(debugDir, fileName), content);
      }).pipe(Effect.ignore);
    },
  });
