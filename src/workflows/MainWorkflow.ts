import { mkdir } from 'node:fs/promises';
import { chalk } from '@vegapunk/utilities';
import { Data, Effect, Option, Ref, Schedule, Scope } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi';
import { TwitchSocketTag } from '../api/TwitchSocket';
import { ConfigStoreTag } from '../core/Config';
import { WsTopic } from '../core/Constants';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper';
import { CampaignServiceState, CampaignServiceTag } from '../services/CampaignService';
import { DropServiceTag } from '../services/DropService';
import { PointServiceTag } from '../services/PointService';
import { WatchServiceTag } from '../services/WatchService';
import { OfflineWorkflow } from './OfflineWorkflow';
import { SocketWorkflow } from './SocketWorkflow';
import { UpcomingWorkflow } from './UpcomingWorkflow';

import type { TwitchApiError } from '../api/TwitchApi';
import type { TwitchSocketError } from '../api/TwitchSocket';
import type { Campaign, Channel, Drop } from '../core/Schemas';
import type { RuntimeRestart } from '../structures/RuntimeClient';

export class MainWorkflowError extends Data.TaggedError('MainWorkflowError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface MainState {
  readonly currentCampaign: Ref.Ref<Option.Option<Campaign>>;
  readonly currentChannel: Ref.Ref<Option.Option<Channel>>;
  readonly currentDrop: Ref.Ref<Option.Option<Drop>>;
  readonly localMinutesWatched: Ref.Ref<number>;
  readonly nextPointClaim: Ref.Ref<number>;
  readonly nextWatch: Ref.Ref<number>;
  readonly isClaiming: Ref.Ref<boolean>;
  readonly nextCommunityGoalContribution: Ref.Ref<number>;
}

export const resetChannel = (state: MainState): Effect.Effect<void, never, TwitchSocketTag> =>
  Effect.gen(function* () {
    const socket = yield* TwitchSocketTag;
    const curOpt = yield* Ref.get(state.currentChannel);

    if (Option.isSome(curOpt)) {
      const chan = curOpt.value;
      const topics = [WsTopic.ChannelStream, WsTopic.ChannelMoment, WsTopic.ChannelUpdate, WsTopic.ChannelPoint] as const;

      yield* Effect.forEach(topics, (topic) => socket.unlisten(topic, chan.id), {
        concurrency: 'unbounded',
        discard: true,
      }).pipe(Effect.catchAllCause(() => Effect.void));

      yield* Ref.set(state.currentChannel, Option.none());
    }
  });

export const setChannel = (state: MainState, channel: Channel): Effect.Effect<void, never, TwitchSocketTag> =>
  Effect.gen(function* () {
    const curOpt = yield* Ref.get(state.currentChannel);
    if (Option.isSome(curOpt) && curOpt.value.id === channel.id) {
      return;
    }

    yield* resetChannel(state);
    yield* Ref.set(state.currentChannel, Option.some(channel));
  });

const shouldSwitchCampaign = (state: MainState, campaign: Campaign, activeCampaigns: readonly Campaign[]): Effect.Effect<boolean, never, never> =>
  Effect.gen(function* () {
    const higherPriority = activeCampaigns[0];
    if (!higherPriority || higherPriority.id === campaign.id) {
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
): Effect.Effect<
  void,
  TwitchApiError | TwitchSocketError | MainWorkflowError,
  TwitchApiTag | TwitchSocketTag | CampaignServiceTag | DropServiceTag
> =>
  Effect.gen(function* () {
    const dropService = yield* DropServiceTag;
    const currentMinutesWatched = drop.currentMinutesWatched + 1;
    const updatedDrop = { ...drop, currentMinutesWatched };

    yield* Effect.logInfo(chalk`{green ${drop.name}} | {green ${channel.login}} | {green ${currentMinutesWatched}/${drop.requiredMinutesWatched}}`);
    yield* Ref.set(state.currentDrop, Option.some(updatedDrop));

    if (isMinutesWatchedMet(updatedDrop)) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {green Completed!} | {green ${currentMinutesWatched}/${drop.requiredMinutesWatched}}`);
      yield* dropService.claimDropSequence(campaign, updatedDrop, state.isClaiming, state.currentDrop);
      yield* resetChannel(state);
      return;
    }

    const socket = yield* TwitchSocketTag;
    const topics = [WsTopic.ChannelStream, WsTopic.ChannelMoment, WsTopic.ChannelUpdate, WsTopic.ChannelPoint] as const;
    yield* Effect.forEach(topics, (topic) => socket.listen(topic, channel.id), {
      concurrency: 'unbounded',
      discard: true,
    }).pipe(Effect.ignore);

    const localMin = yield* Ref.get(state.localMinutesWatched);
    if (localMin < 20) return;

    yield* dropService.syncDropProgress(updatedDrop, state.localMinutesWatched, state.currentDrop, state.currentChannel);
  });

const watchSession = (
  state: MainState,
  campaign: Campaign,
): Effect.Effect<
  void,
  TwitchApiError | TwitchSocketError | MainWorkflowError,
  ConfigStoreTag | TwitchApiTag | TwitchSocketTag | CampaignServiceTag | DropServiceTag | WatchServiceTag
> =>
  Effect.gen(function* () {
    const isClaiming = yield* Ref.get(state.isClaiming);
    if (isClaiming) {
      yield* Effect.sleep('5 seconds');
      return;
    }

    const campaignService = yield* CampaignServiceTag;
    const watchService = yield* WatchServiceTag;
    const activeCampaigns = yield* campaignService.getSortedActive;
    const higherPriorityCampaign = activeCampaigns[0];

    if (higherPriorityCampaign && (yield* shouldSwitchCampaign(state, campaign, activeCampaigns))) {
      yield* Effect.logInfo(chalk`{yellow Switching to higher priority campaign: ${higherPriorityCampaign.name}}`);
      yield* resetChannel(state);
      return;
    }

    const nowMs = Date.now();
    const nextWatchMs = yield* Ref.get(state.nextWatch);
    if (nowMs < nextWatchMs) {
      yield* Effect.sleep(`${nextWatchMs - nowMs} millis`);
    }

    const curChanOpt = yield* Ref.get(state.currentChannel);
    if (Option.isNone(curChanOpt) || !curChanOpt.value.isOnline) {
      yield* resetChannel(state);
      return;
    }

    const curChan = curChanOpt.value;
    const updatedCurChanOpt = yield* watchService.updateChannelInfo(curChan, state.localMinutesWatched, state.currentChannel);
    if (Option.isNone(updatedCurChanOpt)) {
      yield* resetChannel(state);
      return;
    }

    const updatedCurChan = updatedCurChanOpt.value;
    const isGameChanged = !!updatedCurChan.gameId && !!updatedCurChan.currentGameId && updatedCurChan.gameId !== updatedCurChan.currentGameId;

    if (isGameChanged) {
      yield* Effect.logInfo(chalk`{red ${updatedCurChan.login}} | {red Game changed to ${updatedCurChan.currentGameName}}`);
      yield* resetChannel(state);
      return;
    }

    const watchResult = yield* watchService.watch(updatedCurChan, state.currentChannel);

    if (Date.now() < (yield* Ref.get(state.nextWatch))) {
      return;
    }

    if (!watchResult.success) {
      yield* resetChannel(state);
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

    const campaignState = yield* Ref.get(campaignService.state);
    if (campaignState._tag !== 'Initial') {
      return;
    }

    yield* campaignService.updateCampaigns.pipe(Effect.orDie);
    yield* campaignService.updateProgress.pipe(Effect.orDie);

    const config = yield* configStore.get;
    const campaigns = yield* campaignService.getSortedActive;

    const priorityList = campaigns.filter((c) => c.game !== null && config.priorityList.has(c.game.displayName));
    const priorityConnectedList = campaigns.filter((c) => c.game !== null && config.priorityConnectedList.has(c.game.displayName));

    let activeList = campaigns;
    let priorityMessage = 'Non-';

    if (priorityList.length > 0 || priorityConnectedList.length > 0) {
      activeList = [...priorityList, ...priorityConnectedList];
      priorityMessage = '';
    }

    yield* Effect.logInfo(chalk`{bold.yellow Checking ${activeList.length} ${priorityMessage}Priority game!}`);

    const nextState = priorityList.length > 0 || priorityConnectedList.length > 0 ? CampaignServiceState.PriorityOnly() : CampaignServiceState.All();

    yield* Ref.set(campaignService.state, nextState);
    yield* Ref.set(state.isClaiming, false);
  });

const ensureChannelPoints = (
  state: MainState,
  activeList: readonly Campaign[],
): Effect.Effect<
  void,
  TwitchApiError | TwitchSocketError | MainWorkflowError,
  CampaignServiceTag | TwitchApiTag | ConfigStoreTag | PointServiceTag
> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const campaignService = yield* CampaignServiceTag;
    const pointService = yield* PointServiceTag;

    const channelOpt = yield* Ref.get(state.currentChannel);
    if (Option.isSome(channelOpt)) {
      yield* pointService.claimPoints(channelOpt.value).pipe(Effect.ignore);
      return;
    }

    for (const campaign of activeList) {
      const channels = yield* campaignService.getChannelsForCampaign(campaign);
      if (channels.length > 0) {
        yield* api.channelPoints(channels[0].login).pipe(Effect.ignore);
        break;
      }
    }
  });

const processCampaignChannels = (
  state: MainState,
  campaign: Campaign,
  drops: readonly Drop[],
  channels: readonly Channel[],
): Effect.Effect<
  void,
  TwitchApiError | TwitchSocketError | MainWorkflowError,
  ConfigStoreTag | TwitchApiTag | TwitchSocketTag | CampaignServiceTag | PointServiceTag | WatchServiceTag | DropServiceTag
> =>
  Effect.gen(function* () {
    const pointService = yield* PointServiceTag;
    const watchService = yield* WatchServiceTag;
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

      yield* setChannel(state, channel);
      const chanOpt = yield* watchService.updateChannelInfo(channel, state.localMinutesWatched, state.currentChannel);
      if (Option.isNone(chanOpt)) continue;

      const chan = chanOpt.value;
      yield* Effect.all([pointService.claimPoints(chan), pointService.contributeGoal(chan)], {
        concurrency: 'unbounded',
        discard: true,
      }).pipe(Effect.ignore);

      yield* watchSession(state, campaign);

      const postWatchChan = yield* Ref.get(state.currentChannel);
      if (Option.isNone(postWatchChan)) {
        yield* Ref.set(state.localMinutesWatched, 0);
        continue;
      }

      return;
    }

    yield* resetChannel(state);
  });

const mainLoop = (
  state: MainState,
): Effect.Effect<
  void,
  TwitchApiError | TwitchSocketError | MainWorkflowError,
  ConfigStoreTag | TwitchApiTag | TwitchSocketTag | CampaignServiceTag | PointServiceTag | WatchServiceTag | DropServiceTag
> =>
  Effect.gen(function* () {
    const campaignService = yield* CampaignServiceTag;
    const dropService = yield* DropServiceTag;
    yield* initializeCampaigns(state);

    const activeList = yield* campaignService.getSortedActive;
    if (activeList.length === 0) {
      yield* Effect.gen(function* () {
        const currentState = yield* Ref.get(campaignService.state);
        yield* Ref.set(campaignService.state, CampaignServiceState.Initial());

        if (currentState._tag !== 'PriorityOnly') {
          yield* Effect.logInfo(chalk`{yellow No active campaigns. Checking upcoming...}`);
          yield* Effect.logInfo('');
          yield* Effect.sleep('10 minutes');
        }
      });
      return;
    }

    yield* ensureChannelPoints(state, activeList);

    const campaignInitial = yield* selectCampaign(state, activeList);
    const drops = yield* campaignService.getDropsForCampaign(campaignInitial.id);

    const campaign = (yield* Ref.get(campaignService.campaigns)).get(campaignInitial.id) ?? campaignInitial;

    if (drops.length === 0) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red No active drops}`);
      yield* campaignService.setOffline(campaign.id, true);
      return;
    }

    const { isExpired } = getDropStatus(campaign.startAt, campaign.endAt, Date.now());
    if (isExpired) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red Campaigns expired}`);
      yield* campaignService.updateCampaigns;
      return;
    }

    const drop = yield* selectDrop(state, drops);

    if (!drop.hasPreconditionsMet) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Preconditions not met}`);
      yield* campaignService.setOffline(campaign.id, true);
      yield* resetChannel(state);
      return;
    }

    if (isMinutesWatchedMet(drop)) {
      const configStore = yield* ConfigStoreTag;
      const config = yield* configStore.get;
      if (!config.isClaimDrops) {
        yield* Ref.set(state.currentCampaign, Option.none());
        return;
      }

      yield* dropService.claimDropSequence(campaign, drop, state.isClaiming, state.currentDrop);
      return;
    }

    const channels = yield* campaignService.getChannelsForCampaign(campaign);
    if (channels.length === 0) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red Campaigns offline}`);
      yield* campaignService.setOffline(campaign.id, true);
      yield* resetChannel(state);
      return;
    }

    yield* processCampaignChannels(state, campaign, drops, channels);
  });

const selectCampaign = (state: MainState, activeList: readonly Campaign[]) =>
  Effect.gen(function* () {
    const campaignService = yield* CampaignServiceTag;
    const prevCampaignOpt = yield* Ref.get(state.currentCampaign);
    const oldDropOpt = yield* Ref.get(state.currentDrop);

    const firstCampaign = activeList[0];
    const isNew = Option.match(prevCampaignOpt, { onNone: () => true, onSome: (c) => c.id !== firstCampaign.id });

    if (isNew || Option.isNone(oldDropOpt)) {
      yield* campaignService.updateProgress;
    }

    const campaign = (yield* Ref.get(campaignService.campaigns)).get(firstCampaign.id) ?? firstCampaign;

    yield* Ref.set(state.currentCampaign, Option.some(campaign));

    return campaign;
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

const ensureSettingsDir = Effect.gen(function* () {
  const settingsDir = 'sessions';
  yield* Effect.tryPromise({
    try: () => mkdir(settingsDir, { recursive: true }),
    catch: (e) => new MainWorkflowError({ message: 'Failed to create sessions directory', cause: e }),
  }).pipe(Effect.catchAll(() => Effect.void));
});

export const MainWorkflow: Effect.Effect<
  void,
  RuntimeRestart,
  CampaignServiceTag | TwitchApiTag | ConfigStoreTag | TwitchSocketTag | Scope.Scope | PointServiceTag | WatchServiceTag | DropServiceTag
> = Effect.gen(function* () {
  const api = yield* TwitchApiTag;
  const socket = yield* TwitchSocketTag;

  yield* ensureSettingsDir.pipe(Effect.ignore);

  const state: MainState = {
    currentCampaign: yield* Ref.make<Option.Option<Campaign>>(Option.none()),
    currentChannel: yield* Ref.make<Option.Option<Channel>>(Option.none()),
    currentDrop: yield* Ref.make<Option.Option<Drop>>(Option.none()),
    localMinutesWatched: yield* Ref.make(0),
    nextPointClaim: yield* Ref.make(0),
    nextWatch: yield* Ref.make(0),
    isClaiming: yield* Ref.make(false),
    nextCommunityGoalContribution: yield* Ref.make(0),
  };

  yield* api.init.pipe(Effect.orDie);
  const userId = yield* api.userId.pipe(Effect.orDie);

  yield* api.claimAllDropsFromInventory.pipe(Effect.ignore, Effect.forkScoped);

  yield* Effect.acquireRelease(socket.listen(WsTopic.UserDrop, userId).pipe(Effect.orDie), () =>
    socket.unlisten(WsTopic.UserDrop, userId).pipe(Effect.ignore),
  );
  yield* Effect.acquireRelease(socket.listen(WsTopic.UserPoint, userId).pipe(Effect.orDie), () =>
    socket.unlisten(WsTopic.UserPoint, userId).pipe(Effect.ignore),
  );

  yield* SocketWorkflow(state).pipe(Effect.orDie);

  const mainTaskLoop = mainLoop(state).pipe(Effect.orDie, Effect.repeat(Schedule.forever));

  const claimInventoryLoop = api.claimAllDropsFromInventory.pipe(
    Effect.ignore,
    Effect.zipRight(Effect.sleep('30 minutes')),
    Effect.repeat(Schedule.forever),
  );

  yield* Effect.all([mainTaskLoop, claimInventoryLoop, UpcomingWorkflow(state), OfflineWorkflow(state)], {
    concurrency: 'unbounded',
  }).pipe(Effect.onInterrupt(() => resetChannel(state)));
});
