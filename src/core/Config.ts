import { Context, Data, Layer, Schema, Scope } from 'effect';

import { StoreClientLayer } from '../structures/StoreClient';

import type { StoreClient } from '../structures/StoreClient';

export const ClientConfigSchema = Schema.Struct({
  isClaimDrops: Schema.Boolean,
  isClaimPoints: Schema.Boolean,
  isClaimMoments: Schema.Boolean,
  isPriorityOnly: Schema.Boolean,
  usePriorityConnected: Schema.Boolean,
  priorityList: Schema.Set(Schema.String),
  exclusionList: Schema.Set(Schema.String),
});

export interface ClientConfig extends Schema.Schema.Type<typeof ClientConfigSchema> {}

export const INITIAL_CONFIG: ClientConfig = Data.struct({
  isClaimDrops: false,
  isClaimPoints: false,
  isClaimMoments: false,
  isPriorityOnly: true,
  usePriorityConnected: true,
  priorityList: new Set<string>(),
  exclusionList: new Set<string>(),
});

export class ConfigStoreTag extends Context.Tag('@core/ConfigStore')<ConfigStoreTag, StoreClient<ClientConfig>>() {}

export const ConfigStoreLayer: Layer.Layer<ConfigStoreTag, never, Scope.Scope> = StoreClientLayer(
  ConfigStoreTag,
  'sessions/settings.json',
  ClientConfigSchema,
  INITIAL_CONFIG,
);
