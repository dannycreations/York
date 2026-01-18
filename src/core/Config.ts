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
}).pipe(Schema.mutable);

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

export const ConfigStoreTag = Context.GenericTag<StoreClient<ClientConfig>>('@core/ConfigStore');

export const ConfigStoreLayer: Layer.Layer<StoreClient<ClientConfig>, never, Scope.Scope> = StoreClientLayer(
  ConfigStoreTag,
  'sessions/settings.json',
  ClientConfigSchema,
  INITIAL_CONFIG,
);

export const EnvSchema = Schema.Struct({
  AUTH_TOKEN: Schema.NonEmptyString,
  IS_DEBUG: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
    decode: (u: unknown) => (typeof u === 'string' ? u === 'true' : Boolean(u)) as never,
  }),
});

export type Env = Schema.Schema.Type<typeof EnvSchema>;
