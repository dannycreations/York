import { chalk } from '@vegapunk/utilities';
import { uniqueId } from '@vegapunk/utilities/common';
import { Effect, Option, Ref, Scope, Stream } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { WsTopic } from '../core/Constants';
import { TwitchApiTag } from '../services/TwitchApi';
import { TwitchSocketTag } from '../services/TwitchSocket';
import { CampaignStoreTag } from '../stores/CampaignStore';

import type { Channel, Drop, SocketMessage } from '../core/Schemas';
import type { MainState } from './MainWorkflow';

const handleClaimAvailable = (
  payload: Extract<SocketMessage['payload'], { type: 'claim-available' }>,
  channel: Channel,
  state: MainState,
): Effect.Effect<void, never, TwitchApiTag> =>
  Effect.gen(function* () {
    if (payload.data.claim.channel_id !== channel.id) {
      return;
    }

    const api = yield* TwitchApiTag;

    yield* api
      .claimPoints(channel.id, payload.data.claim.id)
      .pipe(
        Effect.zipRight(Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`)),
        Effect.zipRight(Ref.set(state.nextPointClaim, Date.now() + 900_000)),
        Effect.ignore,
      );
  });

const handlePointsEarned = (
  payload: Extract<SocketMessage['payload'], { type: 'points-earned' }>,
  channel: Channel,
  state: MainState,
): Effect.Effect<void, never, TwitchApiTag> =>
  Effect.gen(function* () {
    if (payload.data.channel_id !== channel.id) {
      return;
    }

    const api = yield* TwitchApiTag;
    const now = Date.now();
    const nextClaim = yield* Ref.get(state.nextPointClaim);

    if (now < nextClaim) {
      return;
    }

    const channelDataOpt = yield* api.channelPoints(channel.login).pipe(Effect.option);

    if (Option.isNone(channelDataOpt)) {
      yield* Ref.set(state.nextPointClaim, Date.now() + 900_000);
      return;
    }

    const channelData = channelDataOpt.value;
    const communityPoints = channelData.community.channel.self.communityPoints;
    const availableClaim = communityPoints.availableClaim;

    if (!availableClaim) {
      yield* Ref.set(state.nextPointClaim, Date.now() + 900_000);
      return;
    }

    yield* api.claimPoints(channel.id, availableClaim.id).pipe(Effect.ignore);
    yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);

    yield* Ref.set(state.nextPointClaim, Date.now() + 900_000);
  });

const handleUserPoint = (
  payload: SocketMessage['payload'],
  channel: Channel,
  state: MainState,
): Effect.Effect<void, never, TwitchApiTag | ConfigStoreTag> =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;
    const config = yield* configStore.get;

    if (!config.isClaimPoints) {
      return;
    }

    if (payload.type === 'claim-available') {
      yield* handleClaimAvailable(payload, channel, state);
      return;
    }

    if (payload.type === 'points-earned') {
      yield* handlePointsEarned(payload, channel, state);
      return;
    }
  });

const handleDropProgress = (
  payload: Extract<SocketMessage['payload'], { type: 'drop-progress' }>,
  drop: Drop,
  state: MainState,
): Effect.Effect<void, never, CampaignStoreTag> =>
  Effect.gen(function* () {
    if (payload.data.drop_id !== drop.id) {
      return;
    }

    const progress = payload.data.current_progress_min;
    const desync = progress - drop.currentMinutesWatched;

    if (desync === 0) {
      return;
    }

    const updatedDrop = { ...drop, currentMinutesWatched: progress };

    yield* Ref.set(state.currentDrop, Option.some(updatedDrop));
    yield* Ref.set(state.localMinutesWatched, 1);
    yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Desync ${desync > 0 ? '+' : ''}${desync} minutes}`);

    if (progress >= drop.requiredMinutesWatched) {
      const isBroken = !updatedDrop.dropInstanceID;

      if (isBroken) {
        yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Possible broken drops}`);
        const campaignStore = yield* CampaignStoreTag;
        yield* campaignStore.setBroken(drop.campaignId, true);
      }

      yield* Ref.set(state.currentChannel, Option.none());
    }
  });

const handleDropClaim = (payload: Extract<SocketMessage['payload'], { type: 'drop-claim' }>, drop: Drop, state: MainState): Effect.Effect<void> => {
  if (payload.data.drop_id !== drop.id) {
    return Effect.void;
  }

  const updateEffect = Ref.update(state.currentDrop, (d) =>
    Option.map(d, (dr) => ({
      ...dr,
      dropInstanceID: payload.data.drop_instance_id,
    })),
  );

  return updateEffect;
};

const handleUserDrop = (
  payload: SocketMessage['payload'],
  currentDrop: Option.Option<Drop>,
  state: MainState,
): Effect.Effect<void, never, CampaignStoreTag> =>
  Effect.gen(function* () {
    if (Option.isNone(currentDrop)) {
      return;
    }

    const drop = currentDrop.value;

    if (payload.type === 'drop-progress') {
      yield* handleDropProgress(payload, drop, state);
      return;
    }

    if (payload.type === 'drop-claim') {
      yield* handleDropClaim(payload, drop, state);
      return;
    }
  });

const handleChannelStream = (msg: SocketMessage, channel: Channel, state: MainState): Effect.Effect<void> => {
  if (msg.payload.type !== 'stream-down') {
    return Effect.void;
  }

  return Ref.update(state.currentChannel, (current) =>
    Option.match(current, {
      onNone: () => current,
      onSome: (c) => (c.id === channel.id ? Option.some({ ...c, isOnline: false }) : current),
    }),
  ).pipe(Effect.zipRight(Effect.logInfo(chalk`{red ${channel.login}} | {red Stream down}`)));
};

const handleChannelMoment = (msg: SocketMessage, channel: Channel): Effect.Effect<void, never, TwitchSocketTag | TwitchApiTag | ConfigStoreTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const isOtherTopic = msg.topicId !== channel.id;

    if (isOtherTopic) {
      const socket = yield* TwitchSocketTag;
      const unlistenEffect = socket.unlisten(WsTopic.ChannelMoment, msg.topicId).pipe(Effect.ignore);
      return yield* unlistenEffect;
    }

    if (msg.payload.type !== 'active') {
      return;
    }

    const config = yield* configStore.get;

    if (!config.isClaimMoments) {
      return;
    }

    yield* api.claimMoments(msg.payload.data.moment_id).pipe(Effect.ignore);
    yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Moments claimed}`);
  });

const handleChannelPoint = (msg: SocketMessage, channel: Channel): Effect.Effect<void, never, TwitchApiTag | ConfigStoreTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const isOtherTopic = msg.topicId !== channel.id;

    if (isOtherTopic) {
      return;
    }

    if (msg.payload.type !== 'claim-available') {
      return;
    }

    const config = yield* configStore.get;

    if (!config.isClaimPoints) {
      return;
    }

    yield* api.claimPoints(channel.id, msg.payload.data.claim.id).pipe(Effect.ignore);
    yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
  });

const handleChannelUpdate = (msg: SocketMessage, channel: Channel, state: MainState): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (msg.payload.type !== 'broadcast_settings_update') {
      return;
    }

    const payload = msg.payload;

    if (!!payload.channel_id && payload.channel_id !== channel.id) {
      return;
    }

    const currentGameId = String(payload.data.game_id);
    if (!!channel.gameId && currentGameId !== channel.gameId) {
      yield* Ref.update(state.currentChannel, (current) =>
        Option.match(current, {
          onNone: () => current,
          onSome: (c) => (c.id === channel.id ? Option.some({ ...c, isOnline: false }) : current),
        }),
      );

      yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Game changed to ${payload.data.game}}`);
    }

    yield* Ref.update(state.currentChannel, (current) =>
      Option.match(current, {
        onNone: () => current,
        onSome: (c) => {
          if (c.id !== channel.id) {
            return current;
          }

          return Option.some({
            ...c,
            currentGameId,
            currentGameName: payload.data.game,
          });
        },
      }),
    );
  });

const processMessage = (
  msg: SocketMessage,
  state: MainState,
  userId: string,
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag | ConfigStoreTag | CampaignStoreTag> =>
  Effect.gen(function* () {
    const channelOpt = yield* Ref.get(state.currentChannel);

    if (Option.isNone(channelOpt)) {
      return;
    }

    const channel = channelOpt.value;
    if (msg.topicId !== userId && msg.topicId !== channel.id) {
      const type = msg.topicType;

      if (type === WsTopic.ChannelStream || type === WsTopic.ChannelMoment || type === WsTopic.ChannelUpdate || type === WsTopic.ChannelPoint) {
        const socket = yield* TwitchSocketTag;
        yield* socket.unlisten(type, msg.topicId).pipe(Effect.ignore);
      }

      return;
    }

    const api = yield* TwitchApiTag;

    const debugFileName = `${msg.topicType}-${msg.payload.type ?? uniqueId()}`;
    yield* api.writeDebugFile(msg, debugFileName);

    const payload = msg.payload;
    const type = msg.topicType;

    if (type === WsTopic.UserDrop) {
      const dropOpt = yield* Ref.get(state.currentDrop);
      return yield* handleUserDrop(payload, dropOpt, state);
    }

    if (type === WsTopic.UserPoint) {
      return yield* handleUserPoint(payload, channel, state);
    }

    if (type === WsTopic.ChannelStream) {
      return yield* handleChannelStream(msg, channel, state);
    }

    if (type === WsTopic.ChannelMoment) {
      return yield* handleChannelMoment(msg, channel);
    }

    if (type === WsTopic.ChannelPoint) {
      return yield* handleChannelPoint(msg, channel);
    }

    if (type === WsTopic.ChannelUpdate) {
      return yield* handleChannelUpdate(msg, channel, state);
    }

    if (payload.type !== 'community-goal-created' && payload.type !== 'community-goal-updated') {
      return;
    }

    const configStore = yield* ConfigStoreTag;
    const config = yield* configStore.get;

    if (!config.isClaimPoints) {
      return;
    }

    yield* api.channelPoints(channel.login).pipe(
      Effect.flatMap((data) => {
        const goals = data.community.channel.communityPointsSettings.goals;
        const startedGoals = goals.filter((g) => g.status === 'STARTED' && g.isInStock);

        if (startedGoals.length === 0) {
          return Effect.void;
        }

        return api.userPointsContribution(channel.login).pipe(
          Effect.flatMap((contributionData) => {
            const userContributions = contributionData.user.channel.self.communityPoints.goalContributions;
            const balance = data.community.channel.self.communityPoints.balance;

            return Effect.forEach(startedGoals, (goal) => {
              const userContrib = userContributions.find((uc) => uc.goal.id === goal.id);
              const userPointsContributedThisStream = userContrib?.userPointsContributedThisStream ?? 0;
              const userLeftToContribute = goal.perStreamUserMaximumContribution - userPointsContributedThisStream;
              const goalLeft = goal.amountNeeded - goal.pointsContributed;
              const amount = Math.min(goalLeft, userLeftToContribute, balance);

              if (amount <= 0) {
                return Effect.void;
              }

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

export const SocketWorkflow = (
  state: MainState,
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag | Scope.Scope | ConfigStoreTag | CampaignStoreTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const socket = yield* TwitchSocketTag;
    const userId = yield* api.userId.pipe(Effect.orDie);

    const messageStream = socket.messages.pipe(
      Stream.filterEffect(() =>
        Effect.gen(function* () {
          const currentCampaign = yield* Ref.get(state.currentCampaign);
          const currentChannel = yield* Ref.get(state.currentChannel);
          return Option.isSome(currentCampaign) && Option.isSome(currentChannel);
        }),
      ),
      Stream.runForEach((msg) => processMessage(msg, state, userId)),
    );

    yield* Effect.forkScoped(messageStream);
  });
