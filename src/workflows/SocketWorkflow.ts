import { chalk } from '@vegapunk/utilities';
import { uniqueId } from '@vegapunk/utilities/common';
import { Effect, Option, Ref, Stream } from 'effect';

import { WsTopic } from '../core/Types';
import { TwitchApiError, TwitchApiTag } from '../services/TwitchApi';
import { TwitchSocketError, TwitchSocketTag } from '../services/TwitchSocket';

import type { ClientConfig } from '../core/Config';
import type { Channel, Drop } from '../core/Types';
import type { TwitchApi } from '../services/TwitchApi';
import type { SocketMessage } from '../services/TwitchSocket';
import type { StoreClient } from '../structures/StoreClient';
import type { MainState } from './MainWorkflow';

export const SocketWorkflow = (
  state: MainState,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const socket = yield* TwitchSocketTag;

    const processMessage = (msg: SocketMessage): Effect.Effect<void, TwitchSocketError | TwitchApiError> =>
      Effect.gen(function* () {
        const currentCampaign = yield* Ref.get(state.currentCampaign);
        const currentChannel = yield* Ref.get(state.currentChannel);
        const currentDrop = yield* Ref.get(state.currentDrop);

        if (Option.isNone(currentCampaign) || Option.isNone(currentChannel)) return;

        const channel = currentChannel.value;
        const userId = yield* api.userId;

        if (msg.topicType === WsTopic.ChannelStream && msg.topicId !== channel.id) {
          return yield* socket.unlisten(WsTopic.ChannelStream, msg.topicId);
        }

        if (msg.topicId !== channel.id && msg.topicId !== userId) return;

        yield* api.writeDebugFile(msg, `${msg.topicType}-${msg.type ?? uniqueId()}`);

        const logEmit = (topic: string) => Effect.logDebug(chalk`AppSocket: Emitted ${topic}.${msg.topicId}`, msg);

        switch (msg.topicType) {
          case WsTopic.ChannelStream: {
            yield* logEmit(WsTopic.ChannelStream);
            if (msg.type === 'stream-down') {
              yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
              yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Stream down}`);
            }
            break;
          }
          case WsTopic.UserPoint: {
            yield* logEmit(WsTopic.UserPoint);
            yield* handleUserPoint(msg, channel, state, api, configStore);
            break;
          }
          case WsTopic.ChannelMoment: {
            yield* logEmit(WsTopic.ChannelMoment);
            if (msg.type === 'active' && msg.moment_id) {
              const config = yield* configStore.get;
              if (config.isClaimMoments) {
                yield* api.claimMoments(msg.moment_id);
                yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Moments claimed}`);
              }
            }
            break;
          }
          case WsTopic.ChannelUpdate: {
            yield* logEmit(WsTopic.ChannelUpdate);
            if (msg.channel_id === channel.id && channel.gameId && msg.game_id) {
              const currentGameId = String(msg.game_id);
              if (currentGameId !== channel.gameId) {
                yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
                yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Game changed to ${msg.game}}`);
              }
              yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, currentGameId, currentGameName: msg.game })));
            }
            break;
          }
          case WsTopic.UserDrop: {
            yield* logEmit(WsTopic.UserDrop);
            yield* handleUserDrop(msg, currentDrop, state);
            break;
          }
        }
      });

    return yield* socket.messages.pipe(Stream.runForEach(processMessage), Effect.orDie, Effect.fork);
  });

const handleUserPoint = (
  msg: SocketMessage,
  channel: Channel,
  state: MainState,
  api: TwitchApi,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<void, TwitchApiError> =>
  Effect.gen(function* () {
    const config = yield* configStore.get;
    if (!config.isClaimPoints) {
      return;
    }

    if (msg.type === 'claim-available' && msg.claim) {
      if (msg.claim.channel_id !== channel.id) {
        return;
      }
      yield* api.claimPoints(channel.id, msg.claim.id);
      yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
      yield* Ref.set(state.nextPointClaim, Date.now() + 900_000);
    } else if (msg.type === 'points-earned') {
      if (msg.channel_id !== channel.id) {
        return;
      }
      const now = Date.now();
      const nextClaim = yield* Ref.get(state.nextPointClaim);
      if (now >= nextClaim) {
        const channelData = yield* api.channelPoints(channel.login);
        const points = channelData.community.channel.self.communityPoints;
        const availableClaim = points.availableClaim;
        if (availableClaim) {
          yield* api.claimPoints(channel.id, availableClaim.id);
          yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
        }
        yield* Ref.set(state.nextPointClaim, Date.now() + 900_000);
      }
    }
  });

const handleUserDrop = (msg: SocketMessage, currentDrop: Option.Option<Drop>, state: MainState): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (Option.isNone(currentDrop)) {
      return;
    }
    const drop = currentDrop.value;

    if (msg.type === 'drop-progress') {
      if (msg.drop_id === drop.id && msg.current_progress_min !== undefined) {
        const progress = msg.current_progress_min;
        const desync = progress - drop.currentMinutesWatched;
        if (desync !== 0) {
          yield* Ref.update(state.currentDrop, (d) => Option.map(d, (dr) => ({ ...dr, currentMinutesWatched: progress })));
          yield* Ref.set(state.minutesWatched, 1);
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Desync ${desync > 0 ? '+' : ''}${desync} minutes}`);
        }
      }
    } else if (msg.type === 'drop-claim') {
      if (msg.drop_id === drop.id && msg.drop_instance_id) {
        yield* Ref.update(state.currentDrop, (d) => Option.map(d, (dr) => ({ ...dr, dropInstanceID: msg.drop_instance_id })));
      }
    }
  });
