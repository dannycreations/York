import { Schema } from 'effect';

export const DateFromAny = Schema.transform(Schema.Union(Schema.String, Schema.Number, Schema.Date), Schema.instanceOf(Date), {
  decode: (u) => new Date(u),
  encode: (d) => d,
  strict: true,
});

export const DropStatus = Schema.Literal('ACTIVE', 'EXPIRED', 'UPCOMING');

export type DropStatus = Schema.Schema.Type<typeof DropStatus>;

export const GameSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  displayName: Schema.String,
  slug: Schema.optional(Schema.String),
});

export type Game = Schema.Schema.Type<typeof GameSchema>;

export const WsTopic = {
  UserDrop: 'user-drop-events',
  UserPoint: 'community-points-user-v1',
  ChannelMoment: 'community-moments-channel-v1',
  ChannelStream: 'video-playback-by-id',
  ChannelUpdate: 'broadcast-settings-update',
} as const;

export type WsTopic = (typeof WsTopic)[keyof typeof WsTopic];

export const RewardSchema = Schema.Struct({
  id: Schema.String,
  lastAwardedAt: DateFromAny,
});

export type Reward = Schema.Schema.Type<typeof RewardSchema>;

export const RewardExpiredMs = 2_592_000_000;

export const DropSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  benefits: Schema.Array(Schema.String),
  campaignId: Schema.String,
  startAt: DateFromAny,
  endAt: DateFromAny,
  requiredMinutesWatched: Schema.Number,
  requiredSubs: Schema.optional(Schema.Number),
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
  startAt: DateFromAny,
  endAt: DateFromAny,
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

export const GqlErrorSchema = Schema.Struct({
  message: Schema.String,
  path: Schema.optional(Schema.Array(Schema.String)),
});

export type GqlError = Schema.Schema.Type<typeof GqlErrorSchema>;

export const GqlExtensionsSchema = Schema.Struct({
  durationMilliseconds: Schema.Number,
  operationName: Schema.String,
  requestID: Schema.String,
});

export type GqlExtensions = Schema.Schema.Type<typeof GqlExtensionsSchema>;

export const GqlResponseSchema = <A, I, R>(data: Schema.Schema<A, I, R>) =>
  Schema.Struct({
    data,
    errors: Schema.optional(Schema.Array(GqlErrorSchema)),
    extensions: Schema.optional(GqlExtensionsSchema),
  });

export interface GqlResponse<T = unknown> {
  readonly data: T;
  readonly errors?: ReadonlyArray<GqlError>;
  readonly extensions?: GqlExtensions;
}

export const ViewerDropsDashboardSchema = Schema.Struct({
  currentUser: Schema.Struct({
    id: Schema.String,
    login: Schema.String,
    dropCampaigns: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        game: GameSchema,
        startAt: DateFromAny,
        endAt: DateFromAny,
        self: Schema.Struct({
          isAccountConnected: Schema.Boolean,
        }),
      }),
    ),
  }),
});

export const CampaignDetailsSchema = Schema.Struct({
  user: Schema.Struct({
    dropCampaign: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      game: GameSchema,
      allow: Schema.optional(
        Schema.Struct({
          channels: Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String }))),
        }),
      ),
      timeBasedDrops: Schema.optional(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            startAt: DateFromAny,
            endAt: DateFromAny,
            requiredMinutesWatched: Schema.Number,
            requiredSubs: Schema.optional(Schema.Number),
            benefitEdges: Schema.Array(
              Schema.Struct({
                benefit: Schema.Struct({
                  id: Schema.String,
                  name: Schema.optional(Schema.String),
                }),
                entitlementLimit: Schema.optional(Schema.Number),
              }),
            ),
            self: Schema.optional(
              Schema.Struct({
                isClaimed: Schema.Boolean,
                hasPreconditionsMet: Schema.Boolean,
                currentMinutesWatched: Schema.Number,
                currentSubs: Schema.optional(Schema.Number),
                dropInstanceID: Schema.NullOr(Schema.String),
              }),
            ),
          }),
        ),
      ),
    }),
  }),
});

export const InventorySchema = Schema.Struct({
  currentUser: Schema.Struct({
    inventory: Schema.Struct({
      gameEventDrops: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          lastAwardedAt: DateFromAny,
        }),
      ),
      dropCampaignsInProgress: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          timeBasedDrops: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              startAt: DateFromAny,
              endAt: DateFromAny,
              requiredMinutesWatched: Schema.Number,
              requiredSubs: Schema.optional(Schema.Number),
              benefitEdges: Schema.Array(
                Schema.Struct({
                  benefit: Schema.Struct({
                    id: Schema.String,
                    name: Schema.optional(Schema.String),
                  }),
                  entitlementLimit: Schema.optional(Schema.Number),
                }),
              ),
              self: Schema.optional(
                Schema.Struct({
                  isClaimed: Schema.Boolean,
                  hasPreconditionsMet: Schema.Boolean,
                  currentMinutesWatched: Schema.Number,
                  currentSubs: Schema.optional(Schema.Number),
                  dropInstanceID: Schema.NullOr(Schema.String),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  }),
});

export const ChannelPointsSchema = Schema.Struct({
  community: Schema.Struct({
    channel: Schema.Struct({
      id: Schema.String,
      self: Schema.Struct({
        communityPoints: Schema.Struct({
          availableClaim: Schema.NullOr(Schema.Struct({ id: Schema.String })),
        }),
      }),
    }),
    currentUser: Schema.optional(
      Schema.Struct({
        id: Schema.String,
      }),
    ),
  }),
});

export const ChannelLiveSchema = Schema.Struct({
  user: Schema.NullOr(
    Schema.Struct({
      stream: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

export const ChannelStreamsSchema = Schema.Struct({
  users: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      login: Schema.String,
      stream: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

export const HelixStreamsSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      user_id: Schema.String,
      user_login: Schema.String,
      game_id: Schema.String,
      game_name: Schema.String,
      type: Schema.String,
      started_at: DateFromAny,
    }),
  ),
});

export const CurrentDropsSchema = Schema.Struct({
  currentUser: Schema.Struct({
    id: Schema.String,
    dropCurrentSession: Schema.NullOr(
      Schema.Struct({
        channel: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            displayName: Schema.String,
          }),
        ),
        game: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            displayName: Schema.String,
          }),
        ),
        currentMinutesWatched: Schema.Number,
        requiredMinutesWatched: Schema.Number,
        dropID: Schema.String,
      }),
    ),
  }),
});

export const GameDirectorySchema = Schema.Struct({
  game: Schema.NullOr(
    Schema.Struct({
      streams: Schema.Struct({
        edges: Schema.Array(
          Schema.Struct({
            node: Schema.Struct({
              broadcaster: Schema.Struct({
                id: Schema.String,
                login: Schema.String,
              }),
            }),
          }),
        ),
      }),
    }),
  ),
});

export const ChannelDropsSchema = Schema.Struct({
  channel: Schema.Struct({
    id: Schema.String,
    viewerDropCampaigns: Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
});

export const PlaybackTokenSchema = Schema.Struct({
  streamPlaybackAccessToken: Schema.Struct({
    value: Schema.String,
    signature: Schema.String,
    authorization: Schema.optional(
      Schema.Struct({
        isForbidden: Schema.Boolean,
        forbiddenReasonCode: Schema.String,
      }),
    ),
  }),
});

export const ClaimDropsSchema = Schema.Struct({
  claimDropRewards: Schema.NullOr(
    Schema.Struct({
      status: Schema.optional(Schema.String),
    }),
  ),
});

export const ClaimPointsSchema = Schema.Struct({
  claimCommunityPoints: Schema.NullOr(
    Schema.Struct({
      claim: Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
        }),
      ),
      currentPoints: Schema.NullOr(Schema.Number),
    }),
  ),
});

export const ClaimMomentsSchema = Schema.Struct({
  claimCommunityMoment: Schema.Struct({
    moment: Schema.Struct({
      id: Schema.String,
    }),
  }),
});

export const SocketMessageDropProgressSchema = Schema.Struct({
  type: Schema.Literal('drop-progress'),
  data: Schema.Struct({
    drop_id: Schema.String,
    current_progress_min: Schema.Number,
    required_progress_min: Schema.Number,
  }),
});

export const SocketMessageDropClaimSchema = Schema.Struct({
  type: Schema.Literal('drop-claim'),
  data: Schema.Struct({
    drop_id: Schema.String,
    drop_instance_id: Schema.String,
  }),
});

export const SocketMessagePointClaimSchema = Schema.Struct({
  type: Schema.Literal('claim-available'),
  data: Schema.Struct({
    claim: Schema.Struct({
      id: Schema.String,
      channel_id: Schema.String,
    }),
  }),
});

export const SocketMessagePointsEarnedSchema = Schema.Struct({
  type: Schema.Literal('points-earned'),
  data: Schema.Struct({
    channel_id: Schema.String,
    point_gain: Schema.Struct({
      total_points: Schema.Number,
    }),
  }),
});

export const SocketMessageStreamDownSchema = Schema.Struct({
  type: Schema.Literal('stream-down'),
});

export const SocketMessageMomentActiveSchema = Schema.Struct({
  type: Schema.Literal('active'),
  data: Schema.Struct({
    moment_id: Schema.String,
  }),
});

export const SocketMessageBroadcastUpdateSchema = Schema.Struct({
  type: Schema.Literal('broadcast_settings_update'),
  channel_id: Schema.optional(Schema.String),
  data: Schema.Struct({
    game_id: Schema.Union(Schema.String, Schema.Number),
    game: Schema.String,
  }),
});

export const SocketMessagePayloadSchema = Schema.Union(
  SocketMessageDropProgressSchema,
  SocketMessageDropClaimSchema,
  SocketMessagePointClaimSchema,
  SocketMessagePointsEarnedSchema,
  SocketMessageStreamDownSchema,
  SocketMessageMomentActiveSchema,
  SocketMessageBroadcastUpdateSchema,
);

export const SocketMessageSchema = Schema.Struct({
  topicType: Schema.String,
  topicId: Schema.String,
  payload: SocketMessagePayloadSchema,
});

export type SocketMessage = Schema.Schema.Type<typeof SocketMessageSchema>;
