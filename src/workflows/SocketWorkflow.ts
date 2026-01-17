import { chalk } from '@vegapunk/utilities';
import { Effect, Option, Ref, Stream } from 'effect';

import { WsTopic } from '../core/Schemas';
import { TwitchApiTag } from '../services/TwitchApi';
import { TwitchSocketTag } from '../services/TwitchSocket';

import type { ClientConfig } from '../core/Config';
import type { Channel, Drop } from '../core/Schemas';
import type { TwitchApi } from '../services/TwitchApi';
import type { SocketMessage } from '../services/TwitchSocket';
import type { StoreClient } from '../structures/StoreClient';
import type { MainState } from './MainWorkflow';

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

    if (payload.type === 'claim-available') {
      if (payload.data.claim.channel_id !== channel.id) {
        return;
      }
      yield* api.claimPoints(channel.id, payload.data.claim.id).pipe(Effect.ignore);
      yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
      yield* Ref.set(state.nextPointClaim, Date.now() + 900_000);
    } else if (payload.type === 'points-earned') {
      if (payload.data.channel_id !== channel.id) {
        return;
      }
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
    }
  });

const handleUserDrop = (payload: SocketMessage['payload'], currentDrop: Option.Option<Drop>, state: MainState): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (Option.isNone(currentDrop)) {
      return;
    }
    const drop = currentDrop.value;

    if (payload.type === 'drop-progress') {
      if (payload.data.drop_id === drop.id) {
        const progress = payload.data.current_progress_min;
        const desync = progress - drop.currentMinutesWatched;
        if (desync !== 0) {
          yield* Ref.update(state.currentDrop, (d) => Option.map(d, (dr) => ({ ...dr, currentMinutesWatched: progress })));
          yield* Ref.set(state.minutesWatched, 1);
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Desync ${desync > 0 ? '+' : ''}${desync} minutes}`);
        }
      }
    } else if (payload.type === 'drop-claim') {
      if (payload.data.drop_id === drop.id) {
        yield* Ref.update(state.currentDrop, (d) => Option.map(d, (dr) => ({ ...dr, dropInstanceID: payload.data.drop_instance_id })));
      }
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
    const currentCampaign = yield* Ref.get(state.currentCampaign);
    const currentChannel = yield* Ref.get(state.currentChannel);
    const currentDrop = yield* Ref.get(state.currentDrop);

    if (Option.isNone(currentCampaign) || Option.isNone(currentChannel)) return;

    const channel = currentChannel.value;

    if (msg.topicType === WsTopic.ChannelStream && msg.topicId !== channel.id) {
      const socket = yield* TwitchSocketTag;
      return yield* socket.unlisten(WsTopic.ChannelStream, msg.topicId).pipe(Effect.ignore);
    }

    if (msg.topicId !== channel.id && msg.topicId !== userId) return;

    yield* api.writeDebugFile(msg, `${msg.topicType}-${msg.payload.type ?? Date.now()}`);

    switch (msg.topicType) {
      case WsTopic.ChannelStream: {
        if (msg.payload.type === 'stream-down') {
          yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
          yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Stream down}`);
        }
        break;
      }
      case WsTopic.UserPoint: {
        yield* handleUserPoint(msg.payload, channel, state, api, configStore);
        break;
      }
      case WsTopic.ChannelMoment: {
        if (msg.payload.type === 'active') {
          if (msg.topicId !== channel.id) {
            const socket = yield* TwitchSocketTag;
            return yield* socket.unlisten(WsTopic.ChannelMoment, msg.topicId).pipe(Effect.ignore);
          }

          const config = yield* configStore.get;
          if (config.isClaimMoments) {
            yield* api.claimMoments(msg.payload.data.moment_id).pipe(Effect.ignore);
            yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Moments claimed}`);
          }
        }
        break;
      }
      case WsTopic.ChannelUpdate: {
        if (msg.payload.type === 'broadcast_settings_update' && channel.gameId) {
          const currentGameId = String(msg.payload.data.game_id);
          if (currentGameId !== channel.gameId) {
            yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
            yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Game changed to ${msg.payload.data.game}}`);
          }
          yield* Ref.update(state.currentChannel, (c) =>
            Option.map(c, (ch) => ({
              ...ch,
              currentGameId,
              currentGameName: msg.payload.type === 'broadcast_settings_update' ? msg.payload.data.game : ch.currentGameName,
            })),
          );
        }
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
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const socket = yield* TwitchSocketTag;
    const userId = yield* api.userId.pipe(Effect.orDie);

    return yield* socket.messages.pipe(
      Stream.runForEach((msg) => processMessage(msg, state, api, configStore, userId)),
      Effect.annotateLogs({ workflow: 'SocketWorkflow' }),
      Effect.orDie,
      Effect.fork,
    );
  });
