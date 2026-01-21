import { Context, Layer, Schema, Scope } from 'effect';

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

export type ClientConfig = Schema.Schema.Type<typeof ClientConfigSchema>;

export const INITIAL_CONFIG: ClientConfig = {
  isClaimDrops: false,
  isClaimPoints: false,
  isClaimMoments: false,
  isPriorityOnly: true,
  usePriorityConnected: true,
  priorityList: new Set(),
  exclusionList: new Set(),
};

export class ConfigStoreTag extends Context.Tag('@core/ConfigStore')<ConfigStoreTag, StoreClient<ClientConfig>>() {}

export const ConfigStoreLayer: Layer.Layer<ConfigStoreTag, never, Scope.Scope> = StoreClientLayer(
  ConfigStoreTag,
  'sessions/settings.json',
  ClientConfigSchema,
  INITIAL_CONFIG,
);
