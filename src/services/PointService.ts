import { chalk } from '@vegapunk/utilities';
import { Context, Effect, Layer } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi';
import { ConfigStoreTag } from '../core/Config';

import type { TwitchApiError } from '../api/TwitchApi';
import type { Channel } from '../core/Schemas';

export interface PointService {
  readonly claimPoints: (channel: Channel) => Effect.Effect<void, TwitchApiError>;
  readonly contributeGoal: (channel: Channel) => Effect.Effect<void, TwitchApiError>;
}

export class PointServiceTag extends Context.Tag('@services/PointService')<PointServiceTag, PointService>() {}

export const PointServiceLayer = Layer.effect(
  PointServiceTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;

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

      contributeGoal: (channel) =>
        Effect.gen(function* () {
          const config = yield* configStore.get;
          if (!config.isClaimPoints) return;

          const channelData = yield* api.channelPoints(channel.login);
          const { balance } = channelData.community.channel.self.communityPoints;

          if (balance <= 0) return;

          const goals = channelData.community.channel.communityPointsSettings.goals.filter((g) => g.status === 'STARTED' && g.isInStock);
          if (goals.length === 0) return;

          const contributionData = yield* api.userPointsContribution(channel.login);
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
        }),
    };
  }),
);
