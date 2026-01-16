import { Schema } from 'effect';

/**
 * Represents the status of a drop campaign.
 */
export const DropStatus = Schema.Literal('ACTIVE', 'EXPIRED', 'UPCOMING');

/**
 * The grace period in minutes for drop expiration checks.
 */
export const GRACE_PERIOD_MINUTES = 10;

/**
 * Calculates the status of a drop based on its start and end times.
 *
 * @param startAt - The start date of the drop.
 * @param endAt - The end date of the drop.
 * @param minutesLeft - Optional remaining minutes to check for early expiration.
 * @returns An object containing `isUpcoming` and `isExpired` flags.
 */
export const getDropStatus = (startAt: Date, endAt: Date, minutesLeft?: number) => {
  const nowMs = Date.now();
  const startAtMs = startAt.getTime();
  const endAtMs = endAt.getTime();

  let isExpired = endAtMs < nowMs;
  if (typeof minutesLeft === 'number') {
    const totalMinutesOffset = minutesLeft + GRACE_PERIOD_MINUTES;
    const deadlineFromMinutesLeftMs = nowMs + totalMinutesOffset * 60_000;
    isExpired = isExpired || endAtMs < deadlineFromMinutesLeftMs;
  }

  const isUpcoming = nowMs < startAtMs && nowMs < endAtMs;

  return {
    isUpcoming,
    isExpired,
  };
};

/**
 * Schema for a Twitch game.
 */
export const GameSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
  displayName: Schema.String,
  slug: Schema.optional(Schema.String),
});

/**
 * Type inferred from GameSchema.
 */
export type Game = Schema.Schema.Type<typeof GameSchema>;

/**
 * Constant defining Twitch PubSub event topics.
 */
export const WsTopic = {
  UserDrop: 'user-drop-events',
  UserPoint: 'community-points-user-v1',
  ChannelMoment: 'community-moments-channel-v1',
  ChannelStream: 'video-playback-by-id',
  ChannelUpdate: 'broadcast-settings-update',
} as const;

export type WsTopic = (typeof WsTopic)[keyof typeof WsTopic];

/**
 * Schema for a rewarded drop benefit.
 */
export const RewardSchema = Schema.Struct({
  id: Schema.String,
  lastAwardedAt: Schema.Date,
});

/**
 * Type inferred from RewardSchema.
 */
export type Reward = Schema.Schema.Type<typeof RewardSchema>;

/**
 * Schema for a specific drop within a campaign.
 */
export const DropSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  benefits: Schema.Array(Schema.String),
  campaignId: Schema.String,
  startAt: Schema.Date,
  endAt: Schema.Date,
  requiredMinutesWatched: Schema.Number,
  requiredSubs: Schema.optional(Schema.Number),
  isClaimed: Schema.Boolean,
  hasPreconditionsMet: Schema.Boolean,
  currentMinutesWatched: Schema.Number,
  dropInstanceID: Schema.optional(Schema.String),
});

/**
 * Type inferred from DropSchema.
 */
export type Drop = Schema.Schema.Type<typeof DropSchema>;

/**
 * Schema for a Twitch drop campaign.
 */
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

/**
 * Type inferred from CampaignSchema.
 */
export type Campaign = Schema.Schema.Type<typeof CampaignSchema>;

/**
 * Schema for a Twitch channel.
 */
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

/**
 * Type inferred from ChannelSchema.
 */
export type Channel = Schema.Schema.Type<typeof ChannelSchema>;

// Twitch API Response Schemas
export const GqlErrorSchema = Schema.Struct({
  message: Schema.String,
  path: Schema.optional(Schema.Array(Schema.String)),
});

export type GqlError = Schema.Schema.Type<typeof GqlErrorSchema>;

/**
 * Factory for creating a GraphQL response schema for a specific data type.
 *
 * @param data - The schema for the expected data field in the response.
 * @returns A schema representing the full GraphQL response.
 */
export const GqlResponseSchema = <A, I, R>(data: Schema.Schema<A, I, R>) =>
  Schema.Struct({
    data,
    errors: Schema.optional(Schema.Array(GqlErrorSchema)),
    extensions: Schema.optional(
      Schema.Struct({
        durationMilliseconds: Schema.Number,
        operationName: Schema.String,
        requestID: Schema.String,
      }),
    ),
  });

/**
 * Type representing a generic GraphQL response.
 *
 * @template T - The type of the data field.
 */
export interface GqlResponse<T = unknown> {
  readonly data: T;
  readonly errors?: ReadonlyArray<GqlError>;
  readonly extensions?: {
    readonly durationMilliseconds: number;
    readonly operationName: string;
    readonly requestID: string;
  };
}

/**
 * Schema for the ViewerDropsDashboard GraphQL response.
 */
export const ViewerDropsDashboardSchema = Schema.Struct({
  currentUser: Schema.Struct({
    id: Schema.String,
    login: Schema.String,
    dropCampaigns: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        game: GameSchema,
        startAt: Schema.String,
        endAt: Schema.String,
        self: Schema.Struct({
          isAccountConnected: Schema.Boolean,
        }),
      }),
    ),
  }),
  rewardCampaignsAvailableToUser: Schema.optional(Schema.Array(Schema.Unknown)),
});

/**
 * Schema for the DropCampaignDetails GraphQL response.
 */
export const CampaignDetailsSchema = Schema.Struct({
  user: Schema.Struct({
    dropCampaign: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      game: GameSchema,
      allow: Schema.Struct({
        channels: Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String }))),
      }),
      timeBasedDrops: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          startAt: Schema.String,
          endAt: Schema.String,
          requiredMinutesWatched: Schema.Number,
          requiredSubs: Schema.optional(Schema.Number),
          benefitEdges: Schema.Array(
            Schema.Struct({
              benefit: Schema.Struct({
                id: Schema.String,
                name: Schema.String,
              }),
            }),
          ),
          self: Schema.optional(
            Schema.Struct({
              isClaimed: Schema.Boolean,
              hasPreconditionsMet: Schema.Boolean,
              currentMinutesWatched: Schema.Number,
              dropInstanceID: Schema.NullOr(Schema.String),
            }),
          ),
        }),
      ),
    }),
  }),
});

/**
 * Schema for the Inventory GraphQL response.
 */
export const InventorySchema = Schema.Struct({
  currentUser: Schema.Struct({
    inventory: Schema.Struct({
      gameEventDrops: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          lastAwardedAt: Schema.String,
        }),
      ),
      dropCampaignsInProgress: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          timeBasedDrops: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              startAt: Schema.String,
              endAt: Schema.String,
              requiredMinutesWatched: Schema.Number,
              requiredSubs: Schema.optional(Schema.Number),
              benefitEdges: Schema.Array(
                Schema.Struct({
                  benefit: Schema.Struct({
                    id: Schema.String,
                    name: Schema.optional(Schema.String),
                  }),
                }),
              ),
              self: Schema.optional(
                Schema.Struct({
                  isClaimed: Schema.Boolean,
                  hasPreconditionsMet: Schema.Boolean,
                  currentMinutesWatched: Schema.Number,
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

/**
 * Schema for the ChannelPointsContext GraphQL response.
 */
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

/**
 * Schema for the UseLive GraphQL response.
 */
export const ChannelLiveSchema = Schema.Struct({
  user: Schema.NullOr(
    Schema.Struct({
      stream: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

/**
 * Schema for the FFZ_StreamFetch GraphQL response.
 */
export const ChannelStreamsSchema = Schema.Struct({
  users: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      login: Schema.String,
      stream: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

/**
 * Schema for the Helix streams API response.
 */
export const HelixStreamsSchema = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      user_id: Schema.String,
      user_login: Schema.String,
      user_name: Schema.String,
      game_id: Schema.String,
      game_name: Schema.String,
      type: Schema.String,
      title: Schema.String,
      viewer_count: Schema.Number,
      started_at: Schema.String,
      language: Schema.String,
      thumbnail_url: Schema.String,
      tag_ids: Schema.Array(Schema.String),
      tags: Schema.Array(Schema.String),
      is_mature: Schema.Boolean,
    }),
  ),
  pagination: Schema.Struct({
    cursor: Schema.optional(Schema.String),
  }),
});

/**
 * Schema for the DropCurrentSessionContext GraphQL response.
 */
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

/**
 * Schema for the DirectoryPage_Game GraphQL response.
 */
export const GameDirectorySchema = Schema.Struct({
  game: Schema.Struct({
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
});

/**
 * Schema for the DropsHighlightService_AvailableDrops GraphQL response.
 */
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

/**
 * Schema for the PlaybackAccessToken GraphQL response.
 */
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

/**
 * Schema for the DropsPage_ClaimDropRewards GraphQL response.
 */
export const ClaimDropsSchema = Schema.Struct({
  claimDropRewards: Schema.NullOr(
    Schema.Struct({
      status: Schema.optional(Schema.String),
    }),
  ),
});

/**
 * Schema for the ClaimCommunityPoints GraphQL response.
 */
export const ClaimPointsSchema = Schema.Struct({
  claimCommunityPoints: Schema.NullOr(
    Schema.Struct({
      claim: Schema.Struct({
        id: Schema.String,
      }),
      currentPoints: Schema.optional(Schema.Number),
    }),
  ),
});

/**
 * Schema for the CommunityMomentCallout_Claim GraphQL response.
 */
export const ClaimMomentsSchema = Schema.Struct({
  claimCommunityMoment: Schema.Struct({
    moment: Schema.Struct({
      id: Schema.String,
    }),
  }),
});
