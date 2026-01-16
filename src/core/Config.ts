import { Context, Schema } from 'effect';

import { StoreClientLayer } from '../structures/StoreClient';

import type { StoreClient } from '../structures/StoreClient';

/**
 * Schema for the application's client configuration.
 */
export const ClientConfigSchema = Schema.Struct({
  isClaimDrops: Schema.Boolean,
  isClaimPoints: Schema.Boolean,
  isClaimMoments: Schema.Boolean,
  isPriorityOnly: Schema.Boolean,
  usePriorityConnected: Schema.Boolean,
  priorityList: Schema.Set(Schema.String),
  exclusionList: Schema.Set(Schema.String),
});

/**
 * Type inferred from ClientConfigSchema.
 */
export type ClientConfig = Schema.Schema.Type<typeof ClientConfigSchema>;

/**
 * Initial configuration values for the application.
 */
export const INITIAL_CONFIG: ClientConfig = {
  isClaimDrops: false,
  isClaimPoints: false,
  isClaimMoments: false,
  isPriorityOnly: true,
  usePriorityConnected: true,
  priorityList: new Set(),
  exclusionList: new Set(),
};

/**
 * Represents the configuration store context.
 */
export class ConfigStoreTag extends Context.Tag('@core/ConfigStore')<ConfigStoreTag, StoreClient<ClientConfig>>() {}

/**
 * Layer providing the configuration store using persistent storage.
 */
export const ConfigStoreLayer = StoreClientLayer(ConfigStoreTag, 'sessions/settings.json', ClientConfigSchema, INITIAL_CONFIG);

/**
 * Schema for environment variables.
 */
export const EnvSchema = Schema.Struct({
  AUTH_TOKEN: Schema.NonEmptyString,
  IS_DEBUG: Schema.optionalWith(Schema.Boolean, {
    default: () => false,
    decode: (u: unknown) => (typeof u === 'string' ? u === 'true' : Boolean(u)),
  }),
});

/**
 * Type inferred from EnvSchema.
 */
export type Env = Schema.Schema.Type<typeof EnvSchema>;
