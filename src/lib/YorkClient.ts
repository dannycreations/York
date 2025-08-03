import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { container, Vegapunk } from '@vegapunk/core';
import { parseJsonc } from '@vegapunk/utilities';
import { z } from '@vegapunk/utilities/strict';

import { TwitchGql } from './api/TwitchGql';
import { TwitchSocket } from './api/TwitchSocket';

const AuthTokenSchema = z.string().min(1, 'AUTH_TOKEN is required!');
const authToken = AuthTokenSchema.parse(process.env.AUTH_TOKEN);

export class YorkClient extends Vegapunk {
  public override config = {
    isClaimDrops: false,
    isClaimPoints: false,
    isClaimMoments: false,
    isDropPriorityOnly: true,
    usePriorityConnected: true,
    priorityList: [],
    exclusionList: [],
  };

  public constructor() {
    super();

    const api = new TwitchGql(authToken);
    const ws = new TwitchSocket(authToken);
    Object.assign(container, { api, ws });
  }

  public override async start(): Promise<void> {
    const settingPath = join(process.cwd(), 'sessions/settings.json');
    await access(settingPath).catch(() => mkdir(dirname(settingPath), { recursive: true }));
    await access(settingPath).catch(() => writeFile(settingPath, JSON.stringify(this.config, null, 2)));

    Object.assign(this.config, parseJsonc(await readFile(settingPath, 'utf8')));

    await Promise.all([container.ws.connect(), container.api.init()]);
    await super.start();
  }

  public override async destroy(): Promise<void> {
    container.ws.dispose();
    process.exit(1);
  }
}

declare module '@vegapunk/core' {
  interface Container {
    readonly api: TwitchGql;
    readonly ws: TwitchSocket;
  }

  interface Vegapunk {
    readonly config: {
      readonly isClaimDrops: boolean;
      readonly isClaimPoints: boolean;
      readonly isClaimMoments: boolean;
      readonly isDropPriorityOnly: boolean;
      readonly usePriorityConnected: boolean;
      readonly priorityList: string[];
      readonly exclusionList: string[];
    };
  }
}
