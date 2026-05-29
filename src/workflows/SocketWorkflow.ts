import { chalk } from '@vegapunk/utilities';
import { uniqueId } from '@vegapunk/utilities/common';
import { Effect, Option, Ref, Scope, Stream } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi';
import { TwitchSocketTag } from '../api/TwitchSocket';
import { ConfigStoreTag } from '../core/Config';
import { WsTopic } from '../core/Constants';
import { CampaignServiceTag } from '../services/CampaignService';

import type { SocketMessage } from '../core/Schemas';
import type { MainState } from './MainWorkflow';

type MessageHandler = (
  msg: SocketMessage,
  state: MainState,
  userId: string,
) => Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag | ConfigStoreTag | CampaignServiceTag>;

const handleUserDrop: MessageHandler = (msg, state) =>
  Effect.gen(function* () {
    const dropOpt = yield* Ref.get(state.currentDrop);
    if (Option.isNone(dropOpt)) return;
    const drop = dropOpt.value;

    if (msg.payload.type === 'drop-progress') {
      const progress = msg.payload.data.current_progress_min;
      const desync = progress - drop.currentMinutesWatched;
      if (desync === 0) return;

      const updatedDrop = { ...drop, currentMinutesWatched: progress };
      yield* Ref.set(state.currentDrop, Option.some(updatedDrop));
      yield* Ref.set(state.localMinutesWatched, 1);
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Desync ${desync > 0 ? '+' : ''}${desync} minutes}`);

      if (progress >= drop.requiredMinutesWatched) {
        if (!updatedDrop.dropInstanceID) {
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Possible broken drops}`);
          const campaignService = yield* CampaignServiceTag;
          yield* campaignService.setBroken(drop.campaignId, true);
        } else {
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {green Completed!} | {green ${progress}/${drop.requiredMinutesWatched}}`);
        }
        yield* Ref.set(state.currentChannel, Option.none());
      }
    } else if (msg.payload.type === 'drop-claim') {
      const payload = msg.payload as Extract<SocketMessage['payload'], { type: 'drop-claim' }>;
      if (payload.data.drop_id === drop.id) {
        yield* Ref.update(
          state.currentDrop,
          Option.map((dr) => ({ ...dr, dropInstanceID: payload.data.drop_instance_id })),
        );
      }
    }
  });

const handleUserPoint: MessageHandler = (msg, state) =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;
    const config = yield* configStore.get;
    if (!config.isClaimPoints) return;

    const channelOpt = yield* Ref.get(state.currentChannel);
    if (Option.isNone(channelOpt)) return;
    const channel = channelOpt.value;

    const api = yield* TwitchApiTag;

    if (msg.payload.type === 'claim-available') {
      if (msg.payload.data.claim.channel_id === channel.id) {
        yield* api
          .claimPoints(channel.id, msg.payload.data.claim.id)
          .pipe(
            Effect.zipRight(Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`)),
            Effect.zipRight(Ref.set(state.nextPointClaim, Date.now() + 900_000)),
            Effect.ignore,
          );
      }
    } else if (msg.payload.type === 'points-earned') {
      if (msg.payload.data.channel_id !== channel.id) return;
      const now = Date.now();
      const nextClaim = yield* Ref.get(state.nextPointClaim);
      if (now < nextClaim) return;

      const channelData = yield* api.channelPoints(channel.login).pipe(Effect.option);
      if (Option.isNone(channelData)) {
        yield* Ref.set(state.nextPointClaim, now + 900_000);
        return;
      }

      const availableClaim = channelData.value.community.channel.self.communityPoints.availableClaim;
      if (!availableClaim) {
        yield* Ref.set(state.nextPointClaim, now + 900_000);
        return;
      }

      yield* api.claimPoints(channel.id, availableClaim.id).pipe(Effect.ignore);
      yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
      yield* Ref.set(state.nextPointClaim, now + 900_000);
    }
  });

const handleChannelStream: MessageHandler = (msg, state) =>
  Effect.gen(function* () {
    if (msg.payload.type !== 'stream-down') return;
    const channelOpt = yield* Ref.get(state.currentChannel);
    if (Option.isSome(channelOpt) && channelOpt.value.id === msg.topicId) {
      yield* Ref.update(
        state.currentChannel,
        Option.map((c) => ({ ...c, isOnline: false })),
      );
      yield* Effect.logInfo(chalk`{red ${channelOpt.value.login}} | {red Stream down}`);
    }
  });

const handleChannelMoment: MessageHandler = (msg, state) =>
  Effect.gen(function* () {
    const channelOpt = yield* Ref.get(state.currentChannel);
    if (Option.isNone(channelOpt) || msg.topicId !== channelOpt.value.id) {
      const socket = yield* TwitchSocketTag;
      yield* socket.unlisten(WsTopic.ChannelMoment, msg.topicId).pipe(Effect.ignore);
      return;
    }

    if (msg.payload.type !== 'active') return;
    const configStore = yield* ConfigStoreTag;
    const config = yield* configStore.get;
    if (!config.isClaimMoments) return;

    const api = yield* TwitchApiTag;
    yield* api.claimMoments(msg.payload.data.moment_id).pipe(Effect.ignore);
    yield* Effect.logInfo(chalk`{green ${channelOpt.value.login}} | {yellow Moments claimed}`);
  });

const handleChannelUpdate: MessageHandler = (msg, state) =>
  Effect.gen(function* () {
    if (msg.payload.type !== 'broadcast_settings_update') return;
    const channelOpt = yield* Ref.get(state.currentChannel);
    if (Option.isNone(channelOpt)) return;

    const channel = channelOpt.value;
    const payload = msg.payload as Extract<SocketMessage['payload'], { type: 'broadcast_settings_update' }>;
    if (!!payload.channel_id && payload.channel_id !== channel.id) return;

    const currentGameId = String(payload.data.game_id);

    if (!!channel.gameId && currentGameId !== channel.gameId) {
      yield* Ref.update(
        state.currentChannel,
        Option.map((c) => ({ ...c, isOnline: false })),
      );
      yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Game changed to ${payload.data.game}}`);
    }

    yield* Ref.update(
      state.currentChannel,
      Option.map((c) => (c.id === channel.id ? { ...c, currentGameId, currentGameName: payload.data.game } : c)),
    );
  });

const handleCommunityGoal: MessageHandler = (msg, state) =>
  Effect.gen(function* () {
    if (msg.payload.type !== 'community-goal-created' && msg.payload.type !== 'community-goal-updated') return;
    const configStore = yield* ConfigStoreTag;
    const config = yield* configStore.get;
    if (!config.isClaimPoints) return;

    const channelOpt = yield* Ref.get(state.currentChannel);
    if (Option.isNone(channelOpt)) return;
    const channel = channelOpt.value;

    const api = yield* TwitchApiTag;
    yield* api.channelPoints(channel.login).pipe(
      Effect.flatMap((data) => {
        const startedGoals = data.community.channel.communityPointsSettings.goals.filter((g) => g.status === 'STARTED' && g.isInStock);
        if (startedGoals.length === 0) return Effect.void;

        return api.userPointsContribution(channel.login).pipe(
          Effect.flatMap((contrib) => {
            const balance = data.community.channel.self.communityPoints.balance;
            const userContribs = contrib.user.channel.self.communityPoints.goalContributions;

            return Effect.forEach(startedGoals, (goal) => {
              const uc = userContribs.find((u) => u.goal.id === goal.id);
              const amount = Math.min(
                goal.amountNeeded - goal.pointsContributed,
                goal.perStreamUserMaximumContribution - (uc?.userPointsContributedThisStream ?? 0),
                balance,
              );
              if (amount <= 0) return Effect.void;
              return api
                .contributeCommunityGoal(channel.id, goal.id, amount)
                .pipe(
                  Effect.zipRight(Effect.logInfo(chalk`{green ${channel.login}} | {yellow Contributed ${amount} points to goal: ${goal.title}}`)),
                  Effect.ignore,
                );
            });
          }),
        );
      }),
      Effect.ignore,
    );
  });

const HANDLERS: Record<string, MessageHandler> = {
  [WsTopic.UserDrop]: handleUserDrop,
  [WsTopic.UserPoint]: handleUserPoint,
  [WsTopic.ChannelStream]: handleChannelStream,
  [WsTopic.ChannelMoment]: handleChannelMoment,
  [WsTopic.ChannelUpdate]: handleChannelUpdate,
  [WsTopic.ChannelPoint]: handleUserPoint,
};

export const SocketWorkflow = (
  state: MainState,
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag | Scope.Scope | ConfigStoreTag | CampaignServiceTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const socket = yield* TwitchSocketTag;
    const userId = yield* api.userId.pipe(Effect.orDie);

    yield* socket.messages.pipe(
      Stream.runForEach((msg) =>
        Effect.gen(function* () {
          const [camp, chan] = yield* Effect.all([Ref.get(state.currentCampaign), Ref.get(state.currentChannel)]);
          if (Option.isNone(camp) || Option.isNone(chan)) {
            return;
          }

          const handler = HANDLERS[msg.topicType];
          if (handler) {
            yield* api.writeDebugFile(msg, `${msg.topicType}-${msg.payload.type ?? uniqueId()}`);
            yield* handler(msg, state, userId);
          }
          yield* handleCommunityGoal(msg, state, userId);
        }),
      ),
      Effect.forkScoped,
    );
  });
