import { chalk } from '@vegapunk/utilities';
import { Context, Effect, Layer, Schema } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi';
import { GqlQueries } from '../api/TwitchGql';
import { ConfigStoreTag } from '../core/Config';
import { ChannelPointsSchema, UserPointsContributionSchema } from '../core/Schemas';

import type { TwitchApiError } from '../api/TwitchApi';
import type { Channel } from '../core/Schemas';

export interface PointService {
  readonly claimPoints: (channel: Channel) => Effect.Effect<void, TwitchApiError>;
  readonly contributeGoals: (channel: Channel) => Effect.Effect<void, TwitchApiError>;
  readonly claimAndContribute: (channel: Channel) => Effect.Effect<void, TwitchApiError>;
}

export class PointServiceTag extends Context.Tag('@services/PointService')<PointServiceTag, PointService>() {}

export const PointServiceLayer = Layer.effect(
  PointServiceTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;

    const fetchChannelAndContribution = (channel: Channel) =>
      api
        .graphqlBatch(
          [GqlQueries.channelPoints(channel.login), GqlQueries.userPointsContribution(channel.login)],
          [ChannelPointsSchema, UserPointsContributionSchema],
        )
        .pipe(
          Effect.map(
            (results) => results as [Schema.Schema.Type<typeof ChannelPointsSchema>, Schema.Schema.Type<typeof UserPointsContributionSchema>],
          ),
        );

    const contributeWithData = (
      channel: Channel,
      channelData: Schema.Schema.Type<typeof ChannelPointsSchema>,
      contributionData: Schema.Schema.Type<typeof UserPointsContributionSchema>,
    ) =>
      Effect.gen(function* () {
        const goals = channelData.community.channel.communityPointsSettings.goals.filter((g) => g.status === 'STARTED' && g.isInStock);
        if (goals.length === 0) return;

        const balance = channelData.community.channel.self.communityPoints.balance;
        if (balance <= 0) return;

        const userContributions = contributionData.user.channel.self.communityPoints.goalContributions;

        for (const goal of goals) {
          const userContrib = userContributions.find((uc) => uc.goal.id === goal.id);
          const amount = Math.min(
            goal.amountNeeded - goal.pointsContributed,
            goal.perStreamUserMaximumContribution - (userContrib?.userPointsContributedThisStream ?? 0),
            balance,
          );

          if (amount <= 0) continue;

          yield* api.contributeCommunityGoal(channel.id, goal.id, amount);
          yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Contributed ${amount} points to goal: ${goal.title}}`);
        }
      });

    return {
      claimPoints: (channel) =>
        Effect.gen(function* () {
          const config = yield* configStore.get;
          if (!config.isClaimPoints) return;

          const channelData = yield* api.channelPoints(channel.login);
          const availableClaim = channelData.community.channel.self.communityPoints.availableClaim;

          if (!availableClaim) return;

          yield* api.claimPoints(channel.id, availableClaim.id);
          yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
        }),

      contributeGoals: (channel) =>
        Effect.gen(function* () {
          const config = yield* configStore.get;
          if (!config.isClaimPoints) return;

          const [channelData, contributionData] = yield* fetchChannelAndContribution(channel);
          yield* contributeWithData(channel, channelData, contributionData);
        }),

      claimAndContribute: (channel) =>
        Effect.gen(function* () {
          const config = yield* configStore.get;
          if (!config.isClaimPoints) return;

          const [channelData, contributionData] = yield* fetchChannelAndContribution(channel);

          const availableClaim = channelData.community.channel.self.communityPoints.availableClaim;
          if (availableClaim) {
            yield* api.claimPoints(channel.id, availableClaim.id);
            yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
          }

          yield* contributeWithData(channel, channelData, contributionData);
        }),
    } satisfies PointService;
  }),
);
