import { chalk } from '@vegapunk/utilities';
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

        yield* api.writeDebugFile(msg, `${msg.topicType}-${msg.payload.type ?? Date.now()}`);

        const logEmit = (topic: string) => Effect.logDebug(chalk`AppSocket: Emitted ${topic}.${msg.topicId}`, msg);

        switch (msg.topicType) {
          case WsTopic.ChannelStream: {
            yield* logEmit(WsTopic.ChannelStream);
            if (msg.payload.type === 'stream-down') {
              yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
              yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Stream down}`);
            }
            break;
          }
          case WsTopic.UserPoint: {
            yield* logEmit(WsTopic.UserPoint);
            yield* handleUserPoint(msg.payload, channel, state, api, configStore);
            break;
          }
          case WsTopic.ChannelMoment: {
            yield* logEmit(WsTopic.ChannelMoment);
            if (msg.payload.type === 'active' && msg.payload.moment_id) {
              const config = yield* configStore.get;
              if (config.isClaimMoments) {
                yield* api.claimMoments(msg.payload.moment_id);
                yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Moments claimed}`);
              }
            }
            break;
          }
          case WsTopic.ChannelUpdate: {
            yield* logEmit(WsTopic.ChannelUpdate);
            if (msg.payload.type === 'broadcast_settings_update' && channel.gameId) {
              const currentGameId = String(msg.payload.game_id);
              if (currentGameId !== channel.gameId) {
                yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
                yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Game changed to ${msg.payload.game}}`);
              }
              yield* Ref.update(state.currentChannel, (c) =>
                Option.map(c, (ch) => ({
                  ...ch,
                  currentGameId,
                  currentGameName: msg.payload.type === 'broadcast_settings_update' ? msg.payload.game : ch.currentGameName,
                })),
              );
            }
            break;
          }
          case WsTopic.UserDrop: {
            yield* logEmit(WsTopic.UserDrop);
            yield* handleUserDrop(msg.payload, currentDrop, state);
            break;
          }
        }
      });

    return yield* socket.messages.pipe(
      Stream.runForEach(processMessage),
      Effect.annotateLogs({ workflow: 'SocketWorkflow' }),
      Effect.orDie,
      Effect.fork,
    );
  });

const handleUserPoint = (
  payload: SocketMessage['payload'],
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

    if (payload.type === 'claim-available') {
      if (payload.claim.channel_id !== channel.id) {
        return;
      }
      yield* api.claimPoints(channel.id, payload.claim.id);
      yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
      yield* Ref.set(state.nextPointClaim, Date.now() + 900_000);
    } else if (payload.type === 'points-earned') {
      if (payload.channel_id !== channel.id) {
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

const handleUserDrop = (payload: SocketMessage['payload'], currentDrop: Option.Option<Drop>, state: MainState): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (Option.isNone(currentDrop)) {
      return;
    }
    const drop = currentDrop.value;

    if (payload.type === 'drop-progress') {
      if (payload.drop_id === drop.id) {
        const progress = payload.current_progress_min;
        const desync = progress - drop.currentMinutesWatched;
        if (desync !== 0) {
          yield* Ref.update(state.currentDrop, (d) => Option.map(d, (dr) => ({ ...dr, currentMinutesWatched: progress })));
          yield* Ref.set(state.minutesWatched, 1);
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Desync ${desync > 0 ? '+' : ''}${desync} minutes}`);
        }
      }
    } else if (payload.type === 'drop-claim') {
      if (payload.drop_id === drop.id) {
        yield* Ref.update(state.currentDrop, (d) => Option.map(d, (dr) => ({ ...dr, dropInstanceID: payload.drop_instance_id })));
      }
    }
  });
