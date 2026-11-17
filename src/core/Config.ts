import { Context, Layer, Schema, SchemaGetter } from 'effect';

import { StoreClientLayer } from '../structures/StoreClient.js';

import type { StoreClient } from '../structures/StoreClient.js';

const StringSet = Schema.Array(Schema.String).pipe(
  Schema.decodeTo(Schema.ReadonlySet(Schema.String), {
    decode: SchemaGetter.transform((items) => new Set(items)),
    encode: SchemaGetter.transform((set) => [...set]),
  }),
);

export const ClientConfigSchema = Schema.Struct({
  isClaimDrops: Schema.Boolean,
  isClaimPoints: Schema.Boolean,
  isClaimMoments: Schema.Boolean,
  isPriorityOnly: Schema.Boolean,
  usePriorityConnected: Schema.Boolean,
  priorityList: StringSet,
  priorityConnectedList: StringSet,
  exclusionList: StringSet,
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

export class ConfigStoreTag extends Context.Service<ConfigStoreTag, StoreClient<ClientConfig>>()('@core/ConfigStore') {}

export const ConfigStoreLayer: Layer.Layer<ConfigStoreTag> = StoreClientLayer(
  ConfigStoreTag,
  'sessions/settings.json',
  ClientConfigSchema,
  INITIAL_CONFIG,
  1000,
  true,
);
