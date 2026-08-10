import { chalk } from '@vegapunk/utilities';
import { Context, Effect, Layer, Ref } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi.js';
import { GqlQueries } from '../api/TwitchGql.js';
import { ConfigStoreTag } from '../core/Config.js';
import { ChannelPointsSchema, PointsMutationSchema, UserPointsContributionSchema } from '../core/Schemas.js';

import type { Schema } from 'effect';
import type { TwitchApiError } from '../api/TwitchApi.js';
import type { GraphqlRequest } from '../api/TwitchGql.js';
import type { Channel } from '../core/Schemas.js';

const GOAL_COOLDOWN_MS = 60_000;

export interface PointService {
  readonly contributeGoals: (channel: Channel) => Effect.Effect<void, TwitchApiError>;
  readonly claimAndContribute: (channel: Channel) => Effect.Effect<void, TwitchApiError>;
}

export class PointServiceTag extends Context.Tag('@services/PointService')<PointServiceTag, PointService>() {}

interface PointMutation {
  readonly request: GraphqlRequest;
  readonly message: string;
}

const planMutations = (
  channel: Channel,
  channelData: Schema.Schema.Type<typeof ChannelPointsSchema>,
  contributionData: Schema.Schema.Type<typeof UserPointsContributionSchema>,
  withClaim: boolean,
): ReadonlyArray<PointMutation> => {
  const mutations: PointMutation[] = [];
  const points = channelData.community.channel.self.communityPoints;

  if (withClaim && points.availableClaim) {
    mutations.push({
      request: GqlQueries.claimPoints(channel.id, points.availableClaim.id),
      message: 'Points claimed',
    });
  }

  const contributions = contributionData.user.channel.self.communityPoints.goalContributions;
  let balance = points.balance;

  for (const goal of channelData.community.channel.communityPointsSettings.goals) {
    if (balance <= 0) break;
    if (goal.status !== 'STARTED' || !goal.isInStock) continue;

    const contributed = contributions.find((uc) => uc.goal.id === goal.id)?.userPointsContributedThisStream ?? 0;
    const amount = Math.min(goal.amountNeeded - goal.pointsContributed, goal.perStreamUserMaximumContribution - contributed, balance);

    if (amount <= 0) continue;

    balance -= amount;
    mutations.push({
      request: GqlQueries.contributeCommunityGoal(channel.id, goal.id, amount),
      message: `Contributed ${amount} points to goal: ${goal.title}`,
    });
  }

  return mutations;
};

export const PointServiceLayer = Layer.effect(
  PointServiceTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const lastGoalRunRef = yield* Ref.make<ReadonlyMap<string, number>>(new Map());

    const run = (channel: Channel, withClaim: boolean): Effect.Effect<void, TwitchApiError> =>
      Effect.gen(function* () {
        const config = yield* configStore.get;
        if (!config.isClaimPoints) return;

        const [channelData, contributionData] = yield* api.graphqlBatch(
          [GqlQueries.channelPoints(channel.login), GqlQueries.userPointsContribution(channel.login)],
          [ChannelPointsSchema, UserPointsContributionSchema],
        );

        const mutations = planMutations(channel, channelData, contributionData, withClaim);
        if (mutations.length === 0) return;

        const results = yield* api.graphql(
          mutations.map((m) => m.request),
          PointsMutationSchema,
        );

        yield* Effect.forEach(
          mutations,
          (mutation, index) => {
            const error = results[index]?.contributeCommunityPointsCommunityGoal?.error;

            return error
              ? Effect.logWarning(chalk`{green ${channel.login}} | {red ${mutation.message} failed: ${error}}`)
              : Effect.logInfo(chalk`{green ${channel.login}} | {yellow ${mutation.message}}`);
          },
          { discard: true },
        );
      });

    const isGoalRunAllowed = (channelId: string): Effect.Effect<boolean> =>
      Ref.modify(lastGoalRunRef, (current) => {
        const now = Date.now();
        const last = current.get(channelId);

        if (last !== undefined && now - last < GOAL_COOLDOWN_MS) {
          return [false, current];
        }

        return [true, new Map(current).set(channelId, now)];
      });

    return {
      contributeGoals: (channel) => Effect.whenEffect(run(channel, false), isGoalRunAllowed(channel.id)).pipe(Effect.asVoid),
      claimAndContribute: (channel) => run(channel, true),
    } satisfies PointService;
  }),
);
