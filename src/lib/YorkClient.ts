import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { container, Vegapunk } from '@vegapunk/core';
import { parseJsonc, restartApp } from '@vegapunk/utilities';
import { v } from '@vegapunk/utilities/strict';

import { AppGql } from './api/AppGql';
import { AppSocket } from './api/AppSocket';

interface ClientConfig {
  readonly isClaimDrops: boolean;
  readonly isClaimPoints: boolean;
  readonly isClaimMoments: boolean;
  readonly isPriorityOnly: boolean;
  readonly usePriorityConnected: boolean;
  readonly priorityList: Set<string>;
  readonly exclusionList: Set<string>;
}

const EnvSchema = v.pipe(
  v.object({
    AUTH_TOKEN: v.pipe(v.string(), v.minLength(1)),
  }),
  v.readonly(),
);

const env = v.parse(EnvSchema, process.env);

export class YorkClient extends Vegapunk {
  public override config: ClientConfig = {
    isClaimDrops: false,
    isClaimPoints: false,
    isClaimMoments: false,
    isPriorityOnly: true,
    usePriorityConnected: true,
    priorityList: new Set<string>(),
    exclusionList: new Set<string>(),
  };

  public constructor() {
    super();

    const api = new AppGql(env.AUTH_TOKEN);
    const ws = new AppSocket(env.AUTH_TOKEN);
    Object.assign(container, { api, ws });
  }

  public override async start(): Promise<void> {
    const settingPath = join(process.cwd(), 'sessions/settings.json');
    await this.loadConfig(settingPath);

    await Promise.all([container.ws.connect(), container.api.init()]);
    await super.start();
  }

  public override async destroy(): Promise<void> {
    container.ws.dispose();
    super.destroy();
    restartApp();
  }

  private async loadConfig(settingPath: string): Promise<void> {
    try {
      const parsedConfig = parseJsonc<ClientConfig>(await readFile(settingPath, 'utf8'));
      Object.assign(this.config, {
        ...parsedConfig,
        priorityList: new Set(parsedConfig.priorityList),
        exclusionList: new Set(parsedConfig.exclusionList),
      });
    } catch (error: unknown) {
      await mkdir(dirname(settingPath), { recursive: true });
      await writeFile(settingPath, JSON.stringify(this.config, null, 2));
    }
  }
}

declare module '@vegapunk/core' {
  interface Container {
    readonly api: AppGql;
    readonly ws: AppSocket;
  }

  interface Vegapunk {
    readonly config: ClientConfig;
  }
}
