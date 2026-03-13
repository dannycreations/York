import { chalk } from '@vegapunk/utilities';
import { uniqueId } from '@vegapunk/utilities/common';
import { Effect, Option, Ref, Scope, Stream } from 'effect';

import { WsTopic } from '../core/Constants';
import { TwitchApiTag } from '../services/TwitchApi';
import { TwitchSocketTag } from '../services/TwitchSocket';

import type { ClientConfig } from '../core/Config';
import type { Channel, Drop, SocketMessage } from '../core/Schemas';
import type { TwitchApi } from '../services/TwitchApi';
import type { StoreClient } from '../structures/StoreClient';
import type { MainState } from './MainWorkflow';

const handleClaimAvailable = (
  payload: Extract<SocketMessage['payload'], { type: 'claim-available' }>,
  channel: Channel,
  state: MainState,
  api: TwitchApi,
): Effect.Effect<void, never, TwitchApiTag> => {
  const isTargetChannel = payload.data.claim.channel_id === channel.id;

  if (!isTargetChannel) {
    return Effect.void;
  }

  const claimEffect = api
    .claimPoints(channel.id, payload.data.claim.id)
    .pipe(
      Effect.zipRight(Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`)),
      Effect.zipRight(Ref.set(state.nextPointClaim, Date.now() + 900_000)),
      Effect.ignore,
    );

  return claimEffect;
};

const handlePointsEarned = (
  payload: Extract<SocketMessage['payload'], { type: 'points-earned' }>,
  channel: Channel,
  state: MainState,
  api: TwitchApi,
): Effect.Effect<void, never, TwitchApiTag> => {
  const isTargetChannel = payload.data.channel_id === channel.id;

  if (!isTargetChannel) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    const now = Date.now();
    const nextClaim = yield* Ref.get(state.nextPointClaim);
    const isTooEarly = now < nextClaim;

    if (isTooEarly) {
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

    if (availableClaim) {
      yield* api.claimPoints(channel.id, availableClaim.id).pipe(Effect.ignore);
      yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
    }

    yield* Ref.set(state.nextPointClaim, Date.now() + 900_000);
  });
};

const handleUserPoint = (
  payload: SocketMessage['payload'],
  channel: Channel,
  state: MainState,
  api: TwitchApi,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<void, never, TwitchApiTag> =>
  Effect.gen(function* () {
    const config = yield* configStore.get;
    if (!config.isClaimPoints) {
      return;
    }

    switch (payload.type) {
      case 'claim-available': {
        yield* handleClaimAvailable(payload, channel, state, api);
        break;
      }
      case 'points-earned': {
        yield* handlePointsEarned(payload, channel, state, api);
        break;
      }
    }
  });

const handleDropProgress = (
  payload: Extract<SocketMessage['payload'], { type: 'drop-progress' }>,
  drop: Drop,
  state: MainState,
): Effect.Effect<void> => {
  const isTargetDrop = payload.data.drop_id === drop.id;

  if (!isTargetDrop) {
    return Effect.void;
  }

  return Effect.gen(function* () {
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
      yield* Ref.set(state.currentChannel, Option.none());
    }
  });
};

const handleDropClaim = (payload: Extract<SocketMessage['payload'], { type: 'drop-claim' }>, drop: Drop, state: MainState): Effect.Effect<void> => {
  const isTargetDrop = payload.data.drop_id === drop.id;

  if (!isTargetDrop) {
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

const handleUserDrop = (payload: SocketMessage['payload'], currentDrop: Option.Option<Drop>, state: MainState): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (Option.isNone(currentDrop)) {
      return;
    }
    const drop = currentDrop.value;

    switch (payload.type) {
      case 'drop-progress': {
        yield* handleDropProgress(payload, drop, state);
        break;
      }
      case 'drop-claim': {
        yield* handleDropClaim(payload, drop, state);
        break;
      }
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

const handleChannelMoment = (
  msg: SocketMessage,
  channel: Channel,
  api: TwitchApi,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<void, never, TwitchSocketTag | TwitchApiTag> =>
  Effect.gen(function* () {
    const isOtherTopic = msg.topicId !== channel.id;

    if (isOtherTopic) {
      const socket = yield* TwitchSocketTag;
      const unlistenEffect = socket.unlisten(WsTopic.ChannelMoment, msg.topicId).pipe(Effect.ignore);
      return yield* unlistenEffect;
    }

    const isActive = msg.payload.type === 'active';

    if (!isActive) {
      return;
    }

    const config = yield* configStore.get;

    if (!config.isClaimMoments) {
      return;
    }

    yield* api.claimMoments(msg.payload.data.moment_id).pipe(Effect.ignore);
    yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Moments claimed}`);
  });

const handleChannelUpdate = (msg: SocketMessage, channel: Channel, state: MainState): Effect.Effect<void> =>
  Effect.gen(function* () {
    const isSettingsUpdate = msg.payload.type === 'broadcast_settings_update';

    if (!isSettingsUpdate) {
      return;
    }

    const payload = msg.payload;
    const isTargetChannel = !payload.channel_id || payload.channel_id === channel.id;

    if (!isTargetChannel) {
      return;
    }

    const currentGameId = String(payload.data.game_id);
    const isGameChanged = !!channel.gameId && currentGameId !== channel.gameId;

    if (isGameChanged) {
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
          const isTarget = c.id === channel.id;

          if (!isTarget) {
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
  api: TwitchApi,
  configStore: StoreClient<ClientConfig>,
  userId: string,
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag> =>
  Effect.gen(function* () {
    const channelOpt = yield* Ref.get(state.currentChannel);

    if (Option.isNone(channelOpt)) {
      return;
    }

    const channel = channelOpt.value;
    const isUserTopic = msg.topicId === userId;
    const isChannelTopic = msg.topicId === channel.id;
    const isTopicRelevant = isUserTopic || isChannelTopic;

    if (!isTopicRelevant) {
      const type = msg.topicType;
      const isChannelTopicType = type === WsTopic.ChannelStream || type === WsTopic.ChannelMoment || type === WsTopic.ChannelUpdate;

      if (isChannelTopicType) {
        const socket = yield* TwitchSocketTag;
        yield* socket.unlisten(type, msg.topicId).pipe(Effect.ignore);
      }

      return;
    }

    const debugFileName = `${msg.topicType}-${msg.payload.type ?? uniqueId()}`;
    yield* api.writeDebugFile(msg, debugFileName);

    const payload = msg.payload;
    const type = msg.topicType;

    if (type === WsTopic.UserDrop) {
      const dropOpt = yield* Ref.get(state.currentDrop);
      yield* handleUserDrop(payload, dropOpt, state);
      return;
    }

    if (type === WsTopic.UserPoint) {
      yield* handleUserPoint(payload, channel, state, api, configStore);
      return;
    }

    if (type === WsTopic.ChannelStream) {
      yield* handleChannelStream(msg, channel, state);
      return;
    }

    if (type === WsTopic.ChannelMoment) {
      yield* handleChannelMoment(msg, channel, api, configStore);
      return;
    }

    if (type === WsTopic.ChannelUpdate) {
      yield* handleChannelUpdate(msg, channel, state);
      return;
    }
  });

export const SocketWorkflow = (
  state: MainState,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag | Scope.Scope> =>
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
      Stream.runForEach((msg) => processMessage(msg, state, api, configStore, userId)),
    );

    yield* Effect.forkScoped(messageStream);
  });
