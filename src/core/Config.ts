import { Context, Schema } from 'effect';

import { StoreClient, StoreClientLayer } from '../structures/StoreClient';

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
  priorityList: new Set<string>(),
  exclusionList: new Set<string>(),
};

export class ConfigStore extends Context.Tag('@core/ConfigStore')<ConfigStore, StoreClient<ClientConfig>>() {}

export const ConfigStoreLayer = StoreClientLayer(ConfigStore, 'sessions/settings.json', ClientConfigSchema, INITIAL_CONFIG);

export const EnvSchema = Schema.Struct({
  AUTH_TOKEN: Schema.NonEmptyString,
});

export type Env = Schema.Schema.Type<typeof EnvSchema>;
