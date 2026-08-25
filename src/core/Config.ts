import { Context, Layer, Schema, Scope } from 'effect';

import { StoreClientLayer } from '../structures/StoreClient.js';

import type { StoreClient } from '../structures/StoreClient.js';

export const ClientConfigSchema = Schema.Struct({
  isClaimDrops: Schema.Boolean,
  isClaimPoints: Schema.Boolean,
  isClaimMoments: Schema.Boolean,
  isPriorityOnly: Schema.Boolean,
  usePriorityConnected: Schema.Boolean,
  priorityList: Schema.Set(Schema.String),
  priorityConnectedList: Schema.Set(Schema.String),
  exclusionList: Schema.Set(Schema.String),
});

export type ClientConfig = Schema.Schema.Type<typeof ClientConfigSchema>;

const INITIAL_CONFIG: ClientConfig = {
  isClaimDrops: false,
  isClaimPoints: false,
  isClaimMoments: false,
  isPriorityOnly: true,
  usePriorityConnected: true,
  priorityList: new Set<string>(),
  priorityConnectedList: new Set<string>(),
  exclusionList: new Set<string>(),
};

export const gamePriorityRank = (config: ClientConfig, gameName: string | undefined): number => {
  if (!gameName) return 0;
  if (config.priorityList.has(gameName)) return 2;
  if (config.priorityConnectedList.has(gameName)) return 1;
  return 0;
};

export class ConfigStoreTag extends Context.Tag('@core/ConfigStore')<ConfigStoreTag, StoreClient<ClientConfig>>() {}

export const ConfigStoreLayer: Layer.Layer<ConfigStoreTag, never, Scope.Scope> = StoreClientLayer(
  ConfigStoreTag,
  'sessions/settings.json',
  ClientConfigSchema,
  INITIAL_CONFIG,
  1000,
  true,
);
