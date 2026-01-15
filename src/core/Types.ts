import { Schema } from 'effect';

export const DropStatus = Schema.Literal('ACTIVE', 'EXPIRED', 'UPCOMING');

export const GameSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  slug: Schema.optional(Schema.String),
});

export type Game = Schema.Schema.Type<typeof GameSchema>;

export const RewardSchema = Schema.Struct({
  id: Schema.String,
  lastAwardedAt: Schema.Date,
});

export type Reward = Schema.Schema.Type<typeof RewardSchema>;

export const DropSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  benefits: Schema.Array(Schema.String),
  campaignId: Schema.String,
  startAt: Schema.Date,
  endAt: Schema.Date,
  requiredMinutesWatched: Schema.Number,
  isClaimed: Schema.Boolean,
  hasPreconditionsMet: Schema.Boolean,
  currentMinutesWatched: Schema.Number,
  dropInstanceID: Schema.optional(Schema.String),
});

export type Drop = Schema.Schema.Type<typeof DropSchema>;

export const CampaignSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  game: GameSchema,
  startAt: Schema.Date,
  endAt: Schema.Date,
  isAccountConnected: Schema.Boolean,
  priority: Schema.Number,
  isOffline: Schema.Boolean,
  allowChannels: Schema.Array(Schema.String),
});

export type Campaign = Schema.Schema.Type<typeof CampaignSchema>;

export const ChannelSchema = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  gameId: Schema.optional(Schema.String),
  isOnline: Schema.Boolean,
  currentSid: Schema.optional(Schema.String),
  currentGameId: Schema.optional(Schema.String),
  currentGameName: Schema.optional(Schema.String),
  hlsUrl: Schema.optional(Schema.String),
});

export type Channel = Schema.Schema.Type<typeof ChannelSchema>;
