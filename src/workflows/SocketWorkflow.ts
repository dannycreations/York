import { chalk } from '@vegapunk/utilities';
import { uniqueId } from '@vegapunk/utilities/common';
import { Effect, Option, Ref, Scope, Stream } from 'effect';

import { WsTopic } from '../core/Constants';
import { TwitchApiTag } from '../services/TwitchApi';
import { TwitchSocketTag } from '../services/TwitchSocket';

import type { ClientConfig } from '../core/Config';
import type { Channel, Drop, SocketMessage } from '../core/Schemas';
import type { TwitchApi } from '../services/TwitchApi';
import type { TwitchSocket } from '../services/TwitchSocket';
import type { StoreClient } from '../structures/StoreClient';
import type { MainState } from './MainWorkflow';

const handleClaimAvailable = (
  payload: Extract<SocketMessage['payload'], { type: 'claim-available' }>,
  channel: Channel,
  state: MainState,
  api: TwitchApi,
): Effect.Effect<void, never, TwitchApiTag> =>
  payload.data.claim.channel_id !== channel.id
    ? Effect.void
    : api
        .claimPoints(channel.id, payload.data.claim.id)
        .pipe(
          Effect.zipRight(Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`)),
          Effect.zipRight(Ref.set(state.nextPointClaim, Date.now() + 900_000)),
          Effect.ignore,
        );

const handlePointsEarned = (
  payload: Extract<SocketMessage['payload'], { type: 'points-earned' }>,
  channel: Channel,
  state: MainState,
  api: TwitchApi,
): Effect.Effect<void, never, TwitchApiTag> =>
  payload.data.channel_id !== channel.id
    ? Effect.void
    : Effect.gen(function* () {
        const now = Date.now();
        const nextClaim = yield* Ref.get(state.nextPointClaim);
        if (now >= nextClaim) {
          const channelData = yield* api.channelPoints(channel.login).pipe(Effect.option);
          if (Option.isSome(channelData)) {
            const points = channelData.value.community.channel.self.communityPoints;
            const availableClaim = points.availableClaim;
            if (availableClaim) {
              yield* api.claimPoints(channel.id, availableClaim.id).pipe(Effect.ignore);
              yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
            }
          }
          yield* Ref.set(state.nextPointClaim, Date.now() + 900_000);
        }
      });

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
): Effect.Effect<void> =>
  payload.data.drop_id !== drop.id
    ? Effect.void
    : Effect.gen(function* () {
        const progress = payload.data.current_progress_min;
        const desync = progress - drop.currentMinutesWatched;
        if (desync !== 0) {
          const updatedDrop = { ...drop, currentMinutesWatched: progress };
          yield* Ref.set(state.currentDrop, Option.some(updatedDrop));
          yield* Ref.set(state.localMinutesWatched, 1);
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Desync ${desync > 0 ? '+' : ''}${desync} minutes}`);

          if (progress >= drop.requiredMinutesWatched) {
            yield* Ref.set(state.currentChannel, Option.none());
          }
        }
      });

const handleDropClaim = (payload: Extract<SocketMessage['payload'], { type: 'drop-claim' }>, drop: Drop, state: MainState): Effect.Effect<void> =>
  payload.data.drop_id !== drop.id
    ? Effect.void
    : Ref.update(state.currentDrop, (d) => Option.map(d, (dr) => ({ ...dr, dropInstanceID: payload.data.drop_instance_id })));

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

const handleChannelStream = (msg: SocketMessage, channel: Channel, state: MainState): Effect.Effect<void> =>
  msg.payload.type !== 'stream-down'
    ? Effect.void
    : Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false }))).pipe(
        Effect.zipRight(Effect.logInfo(chalk`{red ${channel.login}} | {red Stream down}`)),
      );

const handleChannelMoment = (
  msg: SocketMessage,
  channel: Channel,
  api: TwitchApi,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<void, never, TwitchSocketTag | TwitchApiTag> =>
  Effect.gen(function* () {
    if (msg.topicId !== channel.id) {
      const socket = yield* TwitchSocketTag;
      return yield* socket.unlisten(WsTopic.ChannelMoment, msg.topicId).pipe(Effect.ignore);
    }

    if (msg.payload.type === 'active') {
      const config = yield* configStore.get;
      if (config.isClaimMoments) {
        yield* api.claimMoments(msg.payload.data.moment_id).pipe(Effect.ignore);
        yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Moments claimed}`);
      }
    }
  });

const handleChannelUpdate = (msg: SocketMessage, channel: Channel, state: MainState): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (msg.payload.type === 'broadcast_settings_update') {
      const payload = msg.payload;
      if (payload.channel_id && payload.channel_id !== channel.id) {
        return;
      }
      const currentGameId = String(payload.data.game_id);
      if (channel.gameId && currentGameId !== channel.gameId) {
        yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
        yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Game changed to ${payload.data.game}}`);
      }
      yield* Ref.update(state.currentChannel, (c) =>
        Option.map(c, (ch) => ({
          ...ch,
          currentGameId,
          currentGameName: payload.data.game,
        })),
      );
    }
  });

const processMessage = (
  msg: SocketMessage,
  state: MainState,
  api: TwitchApi,
  configStore: StoreClient<ClientConfig>,
  userId: string,
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag> =>
  Effect.gen(function* () {
    const currentChannelOpt = yield* Ref.get(state.currentChannel);
    const currentDrop = yield* Ref.get(state.currentDrop);

    if (Option.isNone(currentChannelOpt)) return;

    const channel = currentChannelOpt.value;

    if (msg.topicId !== channel.id && msg.topicId !== userId) {
      if (msg.topicType === WsTopic.ChannelStream || msg.topicType === WsTopic.ChannelMoment || msg.topicType === WsTopic.ChannelUpdate) {
        const socket = yield* TwitchSocketTag;
        yield* socket.unlisten(msg.topicType, msg.topicId).pipe(Effect.ignore);
      }
      return;
    }

    yield* api.writeDebugFile(msg, `${msg.topicType}-${msg.payload.type ?? uniqueId()}`);

    switch (msg.topicType) {
      case WsTopic.ChannelStream: {
        yield* handleChannelStream(msg, channel, state);
        break;
      }
      case WsTopic.UserPoint: {
        yield* handleUserPoint(msg.payload, channel, state, api, configStore);
        break;
      }
      case WsTopic.ChannelMoment: {
        yield* handleChannelMoment(msg, channel, api, configStore);
        break;
      }
      case WsTopic.ChannelUpdate: {
        yield* handleChannelUpdate(msg, channel, state);
        break;
      }
      case WsTopic.UserDrop: {
        yield* handleUserDrop(msg.payload, currentDrop, state);
        break;
      }
    }
  });

export const SocketWorkflow = (
  state: MainState,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag | Scope.Scope> =>
  Effect.gen(function* () {
    const api: TwitchApi = yield* TwitchApiTag;
    const socket: TwitchSocket = yield* TwitchSocketTag;
    const userId = yield* api.userId.pipe(Effect.orDie);

    yield* socket.messages
      .pipe(
        Stream.filterEffect(() =>
          Effect.gen(function* () {
            const currentCampaign = yield* Ref.get(state.currentCampaign);
            const currentChannel = yield* Ref.get(state.currentChannel);
            return Option.isSome(currentCampaign) && Option.isSome(currentChannel);
          }),
        ),
        Stream.runForEach((msg) => processMessage(msg, state, api, configStore, userId)),
        Effect.annotateLogs({ workflow: 'SocketWorkflow' }),
        Effect.orDie,
        Effect.forkScoped,
      )
      .pipe(Effect.asVoid);
  });
