import { chalk } from '@vegapunk/utilities';
import { Effect, Option, Ref, Schedule, Scope } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi.js';
import { TwitchSocketTag } from '../api/TwitchSocket.js';
import { ConfigStoreTag } from '../core/Config.js';
import { WsTopic } from '../core/Constants.js';
import { makeMainState } from '../core/State.js';
import { CHANNEL_LISTENER_TOPICS, resetChannel, setChannel } from '../helpers/ChannelHelper.js';
import { isMinutesWatchedMet } from '../helpers/TwitchHelper.js';
import { CampaignServiceTag } from '../services/CampaignService.js';
import { DropServiceTag } from '../services/DropService.js';
import { PointServiceTag } from '../services/PointService.js';
import { OfflineWorkflow } from './OfflineWorkflow.js';
import { SocketWorkflow } from './SocketWorkflow.js';
import { UpcomingWorkflow } from './UpcomingWorkflow.js';

import type { TwitchApiError } from '../api/TwitchApi.js';
import type { DebugTag } from '../core/Debug.js';
import type { Campaign, Channel, Drop } from '../core/Schemas.js';
import type { MainState } from '../core/State.js';

type WorkflowContext = ConfigStoreTag | DebugTag | TwitchApiTag | TwitchSocketTag | CampaignServiceTag | PointServiceTag | DropServiceTag;

const shouldSwitchCampaign = (state: MainState, campaign: Campaign, higherPriority: Campaign): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (higherPriority.id === campaign.id) {
      return false;
    }

    const curDropOpt = yield* Ref.get(state.currentDrop);

    const hasHigherPriority = higherPriority.priority > campaign.priority;
    const isDifferentGame =
      Option.isSome(curDropOpt) && higherPriority.game !== null && campaign.game !== null && higherPriority.game.id !== campaign.game.id;
    const dropEndsLater = Option.isSome(curDropOpt) && curDropOpt.value.endAt >= higherPriority.endAt;

    return hasHigherPriority || (isDifferentGame && dropEndsLater);
  });

const handleDropProgress = (
  state: MainState,
  campaign: Campaign,
  channel: Channel,
  drop: Drop,
): Effect.Effect<void, TwitchApiError, TwitchApiTag | TwitchSocketTag | CampaignServiceTag | DropServiceTag> =>
  Effect.gen(function* () {
    const dropService = yield* DropServiceTag;
    const currentMinutesWatched = drop.currentMinutesWatched + 1;
    const updatedDrop = { ...drop, currentMinutesWatched };

    yield* Effect.logInfo(chalk`{green ${drop.name}} | {green ${channel.login}} | {green ${currentMinutesWatched}/${drop.requiredMinutesWatched}}`);
    yield* Ref.set(state.currentDrop, Option.some(updatedDrop));

    if (isMinutesWatchedMet(updatedDrop)) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {green Completed!} | {green ${currentMinutesWatched}/${drop.requiredMinutesWatched}}`);
      yield* dropService.claimDropSequence(campaign, updatedDrop, state);
      yield* resetChannel(state.currentChannel);
      return;
    }

    const socket = yield* TwitchSocketTag;
    yield* socket.listen(CHANNEL_LISTENER_TOPICS, channel.id).pipe(Effect.ignore);

    const localMin = yield* Ref.get(state.localMinutesWatched);
    if (localMin < 20) return;

    yield* dropService.syncDropProgress(updatedDrop, state);
  });

const watchSession = (
  state: MainState,
  campaign: Campaign,
  activeCampaigns: readonly Campaign[],
): Effect.Effect<void, TwitchApiError, WorkflowContext> =>
  Effect.gen(function* () {
    const isClaiming = yield* Ref.get(state.isClaiming);
    if (isClaiming) {
      yield* Effect.sleep('5 seconds');
      return;
    }

    const api = yield* TwitchApiTag;
    const higherPriorityCampaign = activeCampaigns[0];

    if (higherPriorityCampaign && (yield* shouldSwitchCampaign(state, campaign, higherPriorityCampaign))) {
      yield* Effect.logInfo(chalk`{yellow Switching to higher priority campaign: ${higherPriorityCampaign.name}}`);
      yield* resetChannel(state.currentChannel);
      return;
    }

    const nowMs = Date.now();
    const nextWatchMs = yield* Ref.get(state.nextWatch);
    if (nowMs < nextWatchMs) {
      yield* Effect.sleep(`${nextWatchMs - nowMs} millis`);
    }

    const curChanOpt = yield* Ref.get(state.currentChannel);
    if (Option.isNone(curChanOpt) || !curChanOpt.value.isOnline) {
      yield* resetChannel(state.currentChannel);
      return;
    }

    const updatedCurChan = curChanOpt.value;
    const isGameChanged = !!updatedCurChan.gameId && !!updatedCurChan.currentGameId && updatedCurChan.gameId !== updatedCurChan.currentGameId;

    if (isGameChanged) {
      yield* Effect.logInfo(chalk`{red ${updatedCurChan.login}} | {red Game changed to ${updatedCurChan.currentGameName}}`);
      yield* resetChannel(state.currentChannel);
      return;
    }

    const watchResult = yield* api.watch(updatedCurChan);

    if (watchResult.hlsUrl !== updatedCurChan.hlsUrl) {
      yield* Ref.update(
        state.currentChannel,
        Option.map((c) => (c.id === updatedCurChan.id ? { ...c, hlsUrl: watchResult.hlsUrl } : c)),
      );
    }

    if (!watchResult.success) {
      yield* resetChannel(state.currentChannel);
      return;
    }

    yield* Ref.update(state.localMinutesWatched, (m) => m + 1);
    yield* Ref.set(state.nextWatch, Date.now() + 60_000);

    const dropCheckOpt = yield* Ref.get(state.currentDrop);
    if (Option.isSome(dropCheckOpt)) {
      yield* handleDropProgress(state, campaign, updatedCurChan, dropCheckOpt.value);
    }
  });

const initializeCampaigns = (state: MainState): Effect.Effect<void, never, CampaignServiceTag | ConfigStoreTag> =>
  Effect.gen(function* () {
    const campaignService = yield* CampaignServiceTag;
    const configStore = yield* ConfigStoreTag;

    const mode = yield* campaignService.getMode;
    if (mode !== 'Initial') {
      return;
    }

    yield* campaignService.updateCampaigns.pipe(Effect.catchAll(() => Effect.void));

    const config = yield* configStore.get;
    const campaigns = yield* campaignService.getSortedActive;

    const priorityList = campaigns.filter((c) => c.game !== null && config.priorityList.has(c.game.displayName));
    const priorityConnectedList = campaigns.filter((c) => c.game !== null && config.priorityConnectedList.has(c.game.displayName));

    const hasPriority = priorityList.length > 0 || priorityConnectedList.length > 0;
    const activeList = hasPriority ? [...priorityList, ...priorityConnectedList] : campaigns;
    const priorityMessage = hasPriority ? '' : 'Non-';

    yield* Effect.logInfo(chalk`{bold.yellow Checking ${activeList.length} ${priorityMessage}Priority game!}`);

    yield* campaignService.setMode(hasPriority ? 'PriorityOnly' : 'All');
    yield* Ref.set(state.isClaiming, false);
  });

const processCampaignChannels = (
  state: MainState,
  campaign: Campaign,
  drops: readonly Drop[],
  channels: readonly Channel[],
  activeCampaigns: readonly Campaign[],
): Effect.Effect<void, TwitchApiError, WorkflowContext> =>
  Effect.gen(function* () {
    const pointService = yield* PointServiceTag;
    const currentChannelOpt = yield* Ref.get(state.currentChannel);

    if (Option.isNone(currentChannelOpt)) {
      yield* Effect.logInfo(chalk`${campaign.name} | {yellow Found ${drops.length} drops / ${channels.length} channels}`);
    }

    const targetChannels = Option.match(currentChannelOpt, {
      onNone: () => channels,
      onSome: (cur) => (channels.some((c) => c.id === cur.id) ? [cur, ...channels.filter((c) => c.id !== cur.id)] : channels),
    });

    for (const channel of targetChannels) {
      const isMet = yield* Ref.get(state.currentDrop).pipe(Effect.map(Option.match({ onNone: () => false, onSome: isMinutesWatchedMet })));
      if (isMet) break;
      if (!channel.currentSid) continue;

      const activeChannelOpt = yield* Ref.get(state.currentChannel);
      const isSameChannel = Option.isSome(activeChannelOpt) && activeChannelOpt.value.id === channel.id;

      yield* setChannel(state.currentChannel, channel);

      if (!isSameChannel) {
        yield* Ref.set(state.nextPointClaim, 0);
      }

      yield* watchSession(state, campaign, activeCampaigns);

      const postWatchChan = yield* Ref.get(state.currentChannel);
      if (Option.isNone(postWatchChan)) {
        yield* Ref.set(state.localMinutesWatched, 0);
        continue;
      }

      const nowMs = Date.now();
      const nextPointClaim = yield* Ref.get(state.nextPointClaim);

      if (nowMs >= nextPointClaim) {
        yield* Ref.set(state.nextPointClaim, nowMs + 300_000);
        yield* pointService.claimAndContribute(channel).pipe(Effect.ignore);
      }

      return;
    }

    yield* resetChannel(state.currentChannel);
  });

const mainLoop = (state: MainState): Effect.Effect<void, TwitchApiError, WorkflowContext> =>
  Effect.gen(function* () {
    const campaignService = yield* CampaignServiceTag;
    const dropService = yield* DropServiceTag;
    yield* initializeCampaigns(state);

    const activeList = yield* campaignService.getSortedActive;
    if (activeList.length === 0) {
      const mode = yield* campaignService.getMode;
      yield* campaignService.setMode('Initial');

      if (mode !== 'PriorityOnly') {
        yield* Effect.logInfo(chalk`{yellow No active campaigns. Checking upcoming...}`);
        yield* Effect.logInfo('');
        yield* Effect.sleep('10 minutes');
      }
      return;
    }

    const campaignInitial = activeList[0];
    yield* Ref.set(state.currentCampaign, Option.some(campaignInitial));

    const drops = yield* campaignService.getDropsForCampaign(campaignInitial.id);
    const campaign = Option.getOrElse(yield* campaignService.getCampaign(campaignInitial.id), () => campaignInitial);

    if (drops.length === 0) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red No active drops}`);
      yield* campaignService.setOffline(campaign.id, true);
      return;
    }

    const drop = yield* selectDrop(state, drops);

    if (!drop.hasPreconditionsMet) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Preconditions not met}`);
      yield* campaignService.setOffline(campaign.id, true);
      yield* resetChannel(state.currentChannel);
      return;
    }

    if (isMinutesWatchedMet(drop)) {
      const configStore = yield* ConfigStoreTag;
      const config = yield* configStore.get;
      if (!config.isClaimDrops) {
        yield* Ref.set(state.currentCampaign, Option.none());
        return;
      }

      yield* dropService.claimDropSequence(campaign, drop, state);
      return;
    }

    const channels = yield* resolveCampaignChannels(state, campaign);
    if (channels.length === 0) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red Campaigns offline}`);
      yield* campaignService.setOffline(campaign.id, true);
      yield* resetChannel(state.currentChannel);
      return;
    }

    yield* processCampaignChannels(state, campaign, drops, channels, activeList);
  });

const isChannelReusable = (channel: Channel, campaign: Campaign): boolean =>
  channel.isOnline && !!channel.currentSid && channel.campaignId === campaign.id;

const resolveCampaignChannels = (state: MainState, campaign: Campaign): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError, CampaignServiceTag> =>
  Effect.gen(function* () {
    const currentChannelOpt = yield* Ref.get(state.currentChannel);

    if (Option.isSome(currentChannelOpt) && isChannelReusable(currentChannelOpt.value, campaign)) {
      return [currentChannelOpt.value];
    }

    const campaignService = yield* CampaignServiceTag;
    return yield* campaignService.getChannelsForCampaign(campaign);
  });

const selectDrop = (state: MainState, drops: readonly Drop[]) =>
  Effect.gen(function* () {
    const oldDropOpt = yield* Ref.get(state.currentDrop);
    const firstDrop = drops[0];
    const drop = Option.match(oldDropOpt, {
      onNone: () => firstDrop,
      onSome: (old) =>
        old.id === firstDrop.id
          ? { ...firstDrop, currentMinutesWatched: Math.max(firstDrop.currentMinutesWatched, old.currentMinutesWatched) }
          : firstDrop,
    });

    yield* Ref.set(state.currentDrop, Option.some(drop));
    return drop;
  });

export const MainWorkflow: Effect.Effect<void, never, WorkflowContext | Scope.Scope> = Effect.gen(function* () {
  const api = yield* TwitchApiTag;
  const socket = yield* TwitchSocketTag;
  const campaignService = yield* CampaignServiceTag;

  const state = yield* makeMainState;

  yield* api.init.pipe(Effect.orDie);
  const userId = yield* api.userId.pipe(Effect.orDie);

  const userTopics = [WsTopic.UserDrop, WsTopic.UserPoint];
  yield* Effect.acquireRelease(socket.listen(userTopics, userId).pipe(Effect.orDie), () => socket.unlisten(userTopics, userId).pipe(Effect.ignore));

  yield* SocketWorkflow(state).pipe(Effect.orDie);

  const mainTaskLoop = mainLoop(state).pipe(
    Effect.catchAll((e) => Effect.logWarning(chalk`{yellow Main loop error: ${e.message}}`).pipe(Effect.zipRight(Effect.sleep('60 seconds')))),
    Effect.repeat(Schedule.forever),
  );

  const claimInventoryLoop = campaignService.claimInventoryDrops.pipe(
    Effect.ignore,
    Effect.zipRight(Effect.sleep('30 minutes')),
    Effect.repeat(Schedule.forever),
  );

  yield* Effect.all([mainTaskLoop, claimInventoryLoop, UpcomingWorkflow(state), OfflineWorkflow(state)], {
    concurrency: 'unbounded',
  }).pipe(Effect.onInterrupt(() => resetChannel(state.currentChannel).pipe(Effect.zipRight(socket.disconnect))));
});
