import { chalk } from '@vegapunk/utilities';
import { Effect, Option, Ref, Scope, Stream } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi.js';
import { TwitchSocketTag } from '../api/TwitchSocket.js';
import { ConfigStoreTag } from '../core/Config.js';
import { WsTopic } from '../core/Constants.js';
import { DebugTag } from '../core/Debug.js';
import { resetChannel } from '../helpers/ChannelHelper.js';
import { CampaignServiceTag } from '../services/CampaignService.js';
import { PointServiceTag } from '../services/PointService.js';

import type { SocketMessage } from '../core/Schemas.js';
import type { MainState } from '../core/State.js';

const POINT_CLAIM_COOLDOWN_MS = 900_000;

type MessageHandler = (
  msg: SocketMessage,
  state: MainState,
) => Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag | ConfigStoreTag | CampaignServiceTag | PointServiceTag>;

const handleUserDrop: MessageHandler = (msg, state) =>
  Effect.gen(function* () {
    const dropOpt = yield* Ref.get(state.currentDrop);
    if (Option.isNone(dropOpt)) return;
    const drop = dropOpt.value;

    if (msg.payload.type === 'drop-progress') {
      if (msg.payload.data.drop_id !== drop.id) return;

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
        yield* resetChannel(state.currentChannel);
      }
    } else if (msg.payload.type === 'drop-claim') {
      const { drop_id, drop_instance_id } = msg.payload.data;
      if (drop_id !== drop.id) return;

      yield* Ref.update(
        state.currentDrop,
        Option.map((dr) => ({ ...dr, dropInstanceID: drop_instance_id })),
      );
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

    if (msg.payload.type !== 'claim-available') return;
    if (msg.payload.data.claim.channel_id !== channel.id) return;

    const api = yield* TwitchApiTag;
    yield* Ref.set(state.nextPointClaim, Date.now() + POINT_CLAIM_COOLDOWN_MS);
    yield* api
      .claimPoints(channel.id, msg.payload.data.claim.id)
      .pipe(Effect.zipRight(Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`)), Effect.ignore);
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
      yield* socket.unlisten([WsTopic.ChannelMoment], msg.topicId).pipe(Effect.ignore);
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
    const { channel_id, data } = msg.payload;
    if (!!channel_id && channel_id !== channel.id) return;

    const currentGameId = String(data.game_id);

    if (!!channel.gameId && currentGameId !== channel.gameId) {
      yield* Ref.update(
        state.currentChannel,
        Option.map((c) => ({ ...c, isOnline: false })),
      );
      yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Game changed to ${data.game}}`);
    }

    yield* Ref.update(
      state.currentChannel,
      Option.map((c) => (c.id === channel.id ? { ...c, currentGameId, currentGameName: data.game } : c)),
    );
  });

const handleCommunityGoal: MessageHandler = (msg, state) =>
  Effect.gen(function* () {
    if (msg.payload.type !== 'community-goal-created' && msg.payload.type !== 'community-goal-updated') return;

    const channelOpt = yield* Ref.get(state.currentChannel);
    if (Option.isNone(channelOpt)) return;

    const pointService = yield* PointServiceTag;
    yield* pointService.contributeGoals(channelOpt.value).pipe(Effect.ignore);
  });

const HANDLERS: Record<string, MessageHandler> = {
  [WsTopic.UserDrop]: handleUserDrop,
  [WsTopic.UserPoint]: handleUserPoint,
  [WsTopic.ChannelStream]: handleChannelStream,
  [WsTopic.ChannelMoment]: handleChannelMoment,
  [WsTopic.ChannelUpdate]: handleChannelUpdate,
  [WsTopic.ChannelPoint]: handleCommunityGoal,
};

export const SocketWorkflow = (
  state: MainState,
): Effect.Effect<void, never, TwitchApiTag | TwitchSocketTag | Scope.Scope | ConfigStoreTag | DebugTag | CampaignServiceTag | PointServiceTag> =>
  Effect.gen(function* () {
    const socket = yield* TwitchSocketTag;
    const debug = yield* DebugTag;

    yield* socket.messages.pipe(
      Stream.runForEach((msg) =>
        Effect.gen(function* () {
          const handler = HANDLERS[msg.topicType];
          if (!handler) return;

          const [camp, chan] = yield* Effect.all([Ref.get(state.currentCampaign), Ref.get(state.currentChannel)]);
          if (Option.isNone(camp) || Option.isNone(chan)) return;

          yield* debug.write(msg, `${msg.topicType}-${msg.payload.type}`);
          yield* handler(msg, state);
        }),
      ),
      Effect.forkScoped,
    );
  });
