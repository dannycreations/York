import { Schema } from 'effect';

const DateFromAny = Schema.transform(Schema.Union(Schema.String, Schema.Number, Schema.Date), Schema.instanceOf(Date), {
  decode: (u) => new Date(u),
  encode: (d) => d,
});

const CommunityGoalSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  isInStock: Schema.Boolean,
  pointsContributed: Schema.Number,
  amountNeeded: Schema.Number,
  perStreamUserMaximumContribution: Schema.Number,
  status: Schema.String,
});

const GameSchema = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  slug: Schema.optional(Schema.String),
}).pipe(Schema.annotations({ identifier: 'Game' }));

export type Game = Schema.Schema.Type<typeof GameSchema>;

export interface Reward {
  readonly id: string;
  readonly lastAwardedAt: Date;
}

export interface Drop {
  readonly id: string;
  readonly name: string;
  readonly benefits: ReadonlyArray<string>;
  readonly campaignId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly requiredMinutesWatched: number;
  readonly requiredSubs: number;
  readonly isClaimed: boolean;
  readonly hasPreconditionsMet: boolean;
  readonly currentMinutesWatched: number;
  readonly dropInstanceID?: string | undefined;
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly game: Game | null;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly isAccountConnected: boolean;
  readonly priority: number;
  readonly isBroken: boolean;
  readonly isOffline: boolean;
  readonly allowChannels: ReadonlyArray<string>;
}

export interface Channel {
  readonly id: string;
  readonly login: string;
  readonly gameId?: string | undefined;
  readonly campaignId?: string | undefined;
  readonly isOnline: boolean;
  readonly currentSid?: string | undefined;
  readonly currentGameId?: string | undefined;
  readonly currentGameName?: string | undefined;
  readonly hlsUrl?: string | undefined;
}

export interface GqlResponse<A> {
  readonly data: A;
  readonly errors?: ReadonlyArray<{ readonly message: string }>;
}

export const ViewerDropsDashboardSchema = Schema.Struct({
  currentUser: Schema.Struct({
    dropCampaigns: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        game: Schema.NullOr(GameSchema),
        startAt: DateFromAny,
        endAt: DateFromAny,
        self: Schema.Struct({
          isAccountConnected: Schema.Boolean,
        }),
      }),
    ),
  }),
});

const TimeBasedDropSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  startAt: DateFromAny,
  endAt: DateFromAny,
  requiredMinutesWatched: Schema.Number,
  requiredSubs: Schema.Number,
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
});

export type TimeBasedDrop = Schema.Schema.Type<typeof TimeBasedDropSchema>;

export const CampaignDetailsSchema = Schema.Struct({
  user: Schema.Struct({
    dropCampaign: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      game: Schema.NullOr(GameSchema),
      allow: Schema.optional(
        Schema.Struct({
          channels: Schema.NullOr(Schema.Array(Schema.Struct({ name: Schema.String }))),
        }),
      ),
      timeBasedDrops: Schema.optional(Schema.Array(TimeBasedDropSchema)),
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
          timeBasedDrops: Schema.Array(TimeBasedDropSchema),
        }),
      ),
    }),
  }),
});

export const ChannelPointsSchema = Schema.Struct({
  community: Schema.Struct({
    channel: Schema.Struct({
      communityPointsSettings: Schema.Struct({
        goals: Schema.Array(CommunityGoalSchema),
      }),
      self: Schema.Struct({
        communityPoints: Schema.Struct({
          balance: Schema.Number,
          availableClaim: Schema.NullOr(Schema.Struct({ id: Schema.String })),
        }),
      }),
    }),
  }),
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
      game_id: Schema.String,
      game_name: Schema.String,
    }),
  ),
});

export const GameDirectorySchema = Schema.Struct({
  game: Schema.NullOr(
    Schema.Struct({
      streams: Schema.Struct({
        edges: Schema.Array(
          Schema.Struct({
            node: Schema.Struct({
              id: Schema.optional(Schema.String),
              game: Schema.optional(Schema.NullOr(GameSchema)),
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
    viewerDropCampaigns: Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String }))),
  }),
});

export const PlaybackTokenSchema = Schema.Struct({
  streamPlaybackAccessToken: Schema.Struct({
    value: Schema.String,
    signature: Schema.String,
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
      claim: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    }),
  ),
});

export const ClaimMomentsSchema = Schema.Struct({
  claimCommunityMoment: Schema.Struct({
    moment: Schema.Struct({ id: Schema.String }),
  }),
});

export const UserPointsContributionSchema = Schema.Struct({
  user: Schema.Struct({
    channel: Schema.Struct({
      self: Schema.Struct({
        communityPoints: Schema.Struct({
          goalContributions: Schema.Array(
            Schema.Struct({
              userPointsContributedThisStream: Schema.Number,
              goal: Schema.Struct({
                id: Schema.String,
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

export const PointsMutationSchema = Schema.Struct({
  contributeCommunityPointsCommunityGoal: Schema.optional(Schema.NullOr(Schema.Struct({ error: Schema.NullOr(Schema.String) }))),
});

const SocketMessageDropProgressSchema = Schema.Struct({
  type: Schema.Literal('drop-progress'),
  data: Schema.Struct({
    drop_id: Schema.String,
    current_progress_min: Schema.Number,
  }),
});

const SocketMessageDropClaimSchema = Schema.Struct({
  type: Schema.Literal('drop-claim'),
  data: Schema.Struct({
    drop_id: Schema.String,
    drop_instance_id: Schema.String,
  }),
});

const SocketMessagePointClaimSchema = Schema.Struct({
  type: Schema.Literal('claim-available'),
  data: Schema.Struct({
    claim: Schema.Struct({
      id: Schema.String,
      channel_id: Schema.String,
    }),
  }),
});

const SocketMessageStreamDownSchema = Schema.Struct({
  type: Schema.Literal('stream-down'),
});

const SocketMessageMomentActiveSchema = Schema.Struct({
  type: Schema.Literal('active'),
  data: Schema.Struct({
    moment_id: Schema.String,
  }),
});

const SocketMessageBroadcastUpdateSchema = Schema.Struct({
  type: Schema.Literal('broadcast_settings_update'),
  channel_id: Schema.optional(Schema.String),
  data: Schema.Struct({
    game_id: Schema.Union(Schema.String, Schema.Number),
    game: Schema.String,
  }),
});

const SocketMessageCommunityGoalSchema = Schema.Struct({
  type: Schema.Literal('community-goal-created', 'community-goal-updated'),
});

const SocketMessagePayloadSchema = Schema.Union(
  SocketMessageDropProgressSchema,
  SocketMessageDropClaimSchema,
  SocketMessagePointClaimSchema,
  SocketMessageStreamDownSchema,
  SocketMessageMomentActiveSchema,
  SocketMessageBroadcastUpdateSchema,
  SocketMessageCommunityGoalSchema,
);

export const SocketMessageSchema = Schema.Struct({
  topicType: Schema.String,
  topicId: Schema.String,
  payload: SocketMessagePayloadSchema,
});

export type SocketMessage = Schema.Schema.Type<typeof SocketMessageSchema>;
