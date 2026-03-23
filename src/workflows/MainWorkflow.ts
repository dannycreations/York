import { mkdir } from 'node:fs/promises';
import { chalk } from '@vegapunk/utilities';
import { Data, Effect, Option, Ref, Schedule, Scope } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { WsTopic } from '../core/Constants';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper';
import { TwitchApiTag } from '../services/TwitchApi';
import { TwitchSocketTag } from '../services/TwitchSocket';
import { CampaignStoreState, CampaignStoreTag } from '../stores/CampaignStore';
import { cycleUntilMidnight } from '../structures/RuntimeClient';
import { OfflineWorkflow } from './OfflineWorkflow';
import { SocketWorkflow } from './SocketWorkflow';
import { UpcomingWorkflow } from './UpcomingWorkflow';

import type { Campaign, Channel, Drop } from '../core/Schemas';
import type { TwitchApiError } from '../services/TwitchApi';
import type { TwitchSocketError } from '../services/TwitchSocket';
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

const resetChannel = (state: MainState): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Ref.update(
      state.currentChannel,
      Option.map((ch) => ({ ...ch, isOnline: false })),
    );
    yield* Ref.set(state.currentChannel, Option.none());
  });

const claimChannelPoints = (channel: Channel): Effect.Effect<void, TwitchApiError, TwitchApiTag | ConfigStoreTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const config = yield* configStore.get;

    if (!config.isClaimPoints) {
      return;
    }

    const channelData = yield* api.channelPoints(channel.login);
    const community = channelData.community.channel;
    const availableClaim = community.self.communityPoints.availableClaim;

    if (!availableClaim) {
      return;
    }

    yield* api.claimPoints(channel.id, availableClaim.id);
    yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
  });

const contributeToCommunityGoals = (state: MainState, channel: Channel): Effect.Effect<void, TwitchApiError, TwitchApiTag | ConfigStoreTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const config = yield* configStore.get;

    if (!config.isClaimPoints) {
      return;
    }

    const now = Date.now();
    const nextContribution = yield* Ref.get(state.nextCommunityGoalContribution);

    if (now < nextContribution) {
      return;
    }

    const channelData = yield* api.channelPoints(channel.login);
    const community = channelData.community.channel;
    const balance = community.self.communityPoints.balance;

    if (balance <= 0) {
      return;
    }

    const goals = community.communityPointsSettings.goals;
    const startedGoals = goals.filter((g) => g.status === 'STARTED' && g.isInStock);

    if (startedGoals.length === 0) {
      return;
    }

    const contributionData = yield* api.userPointsContribution(channel.login);
    const userContributions = contributionData.user.channel.self.communityPoints.goalContributions;

    for (const goal of startedGoals) {
      const userContrib = userContributions.find((uc) => uc.goal.id === goal.id);
      const userPointsContributedThisStream = userContrib?.userPointsContributedThisStream ?? 0;

      const userLeftToContribute = goal.perStreamUserMaximumContribution - userPointsContributedThisStream;
      const goalLeft = goal.amountNeeded - goal.pointsContributed;

      const amount = Math.min(goalLeft, userLeftToContribute, balance);

      if (amount <= 0) {
        continue;
      }

      yield* api.contributeCommunityGoal(channel.id, goal.id, amount);
      yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Contributed ${amount} points to goal: ${goal.title}}`);
    }

    yield* Ref.set(state.nextCommunityGoalContribution, now + 300_000);
  });

const updateChannelInfo = (state: MainState, chan: Channel): Effect.Effect<Option.Option<Channel>, MainWorkflowError, TwitchApiTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const localMin = yield* Ref.get(state.localMinutesWatched);

    if (!!chan.currentSid && localMin > 0 && localMin < 15) {
      return Option.some(chan);
    }

    const streamRes = yield* api.helixStreams(chan.id).pipe(Effect.mapError((e) => new MainWorkflowError({ message: e.message, cause: e })));
    const live = streamRes.data[0];

    if (!live) {
      yield* resetChannel(state);
      return Option.none();
    }

    const updated: Channel = {
      ...chan,
      currentSid: live.id,
      currentGameId: live.game_id,
      currentGameName: live.game_name,
    };

    yield* Ref.update(state.currentChannel, (current) =>
      Option.match(current, {
        onNone: () => Option.some(updated),
        onSome: (c) => (c.id === updated.id ? Option.some(updated) : current),
      }),
    );

    return Option.some(updated);
  });

const handleWatchSuccess = (state: MainState, chan: Channel): Effect.Effect<void, TwitchApiError, CampaignStoreTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    yield* Ref.update(state.localMinutesWatched, (m) => m + 1);
    yield* Ref.set(state.nextWatch, Date.now() + 60_000);

    const dropOpt = yield* Ref.get(state.currentDrop);

    if (Option.isNone(dropOpt)) {
      return;
    }

    const drop = dropOpt.value;
    const currentMinutesWatched = drop.currentMinutesWatched + 1;
    yield* Effect.logInfo(chalk`{green ${drop.name}} | {green ${chan.login}} | {green ${currentMinutesWatched}/${drop.requiredMinutesWatched}}`);

    const updatedDropState = { ...drop, currentMinutesWatched };
    yield* Ref.set(state.currentDrop, Option.some(updatedDropState));

    const isCompleted = isMinutesWatchedMet(updatedDropState);

    if (isCompleted) {
      yield* Ref.set(state.currentChannel, Option.none());
      return;
    }

    const localMin = yield* Ref.get(state.localMinutesWatched);

    if (localMin < 20) {
      return;
    }

    yield* Ref.set(state.localMinutesWatched, 0);
    yield* campaignStore.updateProgress;

    const drops = yield* campaignStore.getDropsForCampaign(drop.campaignId);
    const updatedDrop = drops.find((d) => d.id === drop.id);

    if (!updatedDrop) {
      return;
    }

    if (currentMinutesWatched - updatedDrop.currentMinutesWatched >= 20) {
      yield* Ref.update(
        state.currentChannel,
        Option.map((ch) => ({ ...ch, isOnline: false })),
      );
    }

    yield* Ref.set(state.currentDrop, Option.some(updatedDrop));
  });

const watchChannelTick = (
  state: MainState,
  campaign: Campaign,
): Effect.Effect<void, TwitchApiError | MainWorkflowError, CampaignStoreTag | TwitchApiTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;

    const isClaiming = yield* Ref.get(state.isClaiming);

    if (isClaiming) {
      yield* Effect.sleep('5 seconds');
      return;
    }

    const activeCampaigns = yield* campaignStore.getSortedActive;
    const higherPriority = activeCampaigns[0];

    const isMainCampaign = !higherPriority || higherPriority.id === campaign.id;

    if (isMainCampaign) {
      yield* waitForNextWatch(state);
      yield* watchCurrentChannel(state);
      return;
    }

    const isHigherPriority = higherPriority.priority > campaign.priority;
    const currentDropOpt = yield* Ref.get(state.currentDrop);

    const isSoonerEnding = Option.match(currentDropOpt, {
      onNone: () => false,
      onSome: (d) => higherPriority.game.id !== campaign.game.id && d.endAt >= higherPriority.endAt,
    });

    const shouldSwitch = isHigherPriority || isSoonerEnding;

    if (shouldSwitch) {
      yield* Effect.logInfo(chalk`{yellow Switching to higher priority campaign: ${higherPriority.name}}`);
      yield* resetChannel(state);
      return;
    }

    yield* waitForNextWatch(state);
    yield* watchCurrentChannel(state);
  });

const watchCurrentChannel = (state: MainState): Effect.Effect<void, TwitchApiError | MainWorkflowError, CampaignStoreTag | TwitchApiTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;

    const chanOpt = yield* Ref.get(state.currentChannel);
    if (Option.isNone(chanOpt) || !chanOpt.value.isOnline) {
      yield* Ref.set(state.currentChannel, Option.none());
      return;
    }

    const chan = chanOpt.value;
    const updatedChanOpt = yield* updateChannelInfo(state, chan);

    if (Option.isNone(updatedChanOpt)) {
      return;
    }

    const updatedChan = updatedChanOpt.value;

    const isGameMismatch = !!updatedChan.gameId && !!updatedChan.currentGameId && updatedChan.gameId !== updatedChan.currentGameId;

    if (isGameMismatch) {
      yield* Effect.logInfo(chalk`{red ${updatedChan.login}} | {red Game changed to ${updatedChan.currentGameName}}`);
      yield* resetChannel(state);
      return;
    }

    const { success, hlsUrl } = yield* api.watch(updatedChan);

    const isHlsUrlChanged = hlsUrl !== updatedChan.hlsUrl;

    if (isHlsUrlChanged) {
      yield* Ref.update(state.currentChannel, (current) =>
        Option.match(current, {
          onNone: () => current,
          onSome: (c) => (c.id === updatedChan.id ? Option.some({ ...c, hlsUrl }) : current),
        }),
      );
    }

    const currentTimeMs = Date.now();
    const scheduledWatchMs = yield* Ref.get(state.nextWatch);
    if (currentTimeMs < scheduledWatchMs) {
      return;
    }

    if (!success) {
      yield* resetChannel(state);
      return;
    }

    yield* handleWatchSuccess(state, updatedChan);
  });

const manageChannelSockets = (
  channelId: string,
): Effect.Effect<
  {
    readonly acquire: Effect.Effect<void, TwitchSocketError>;
    readonly release: Effect.Effect<void>;
  },
  never,
  TwitchSocketTag
> =>
  Effect.gen(function* () {
    const socket = yield* TwitchSocketTag;
    const topics = [WsTopic.ChannelStream, WsTopic.ChannelMoment, WsTopic.ChannelUpdate, WsTopic.ChannelPoint] as const;

    const acquire = Effect.forEach(topics, (topic) => socket.listen(topic, channelId), {
      concurrency: 'unbounded',
      discard: true,
    });

    const release = Effect.forEach(topics, (topic) => socket.unlisten(topic, channelId), {
      concurrency: 'unbounded',
      discard: true,
    }).pipe(Effect.catchAllCause(() => Effect.void));

    return { acquire, release };
  });

const waitForNextWatch = (state: MainState): Effect.Effect<void> =>
  Effect.gen(function* () {
    const nowMs = Date.now();
    const nextWatchMs = yield* Ref.get(state.nextWatch);
    if (nowMs < nextWatchMs) {
      yield* Effect.sleep(`${nextWatchMs - nowMs} millis`);
    }
  });

const processChannelWatch = (
  state: MainState,
  campaign: Campaign,
  channel: Channel,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError, TwitchApiTag | ConfigStoreTag | TwitchSocketTag | CampaignStoreTag> =>
  Effect.gen(function* () {
    yield* Ref.set(state.currentChannel, Option.some(channel));

    const chanOpt = yield* updateChannelInfo(state, channel);
    if (Option.isNone(chanOpt)) {
      return;
    }
    const chan = chanOpt.value;

    yield* claimChannelPoints(chan);
    yield* contributeToCommunityGoals(state, chan);

    const { acquire, release } = yield* manageChannelSockets(chan.id);

    const isChannelNone = () => Ref.get(state.currentChannel).pipe(Effect.map(Option.isNone));

    const watchUntilNone = watchChannelTick(state, campaign).pipe(Effect.zipRight(Effect.sleep('1 minute')), Effect.repeat({ until: isChannelNone }));

    yield* watchChannelTick(state, campaign);

    const chanCheck = yield* Ref.get(state.currentChannel);

    if (Option.isNone(chanCheck)) {
      return;
    }

    yield* Effect.acquireUseRelease(
      acquire,
      () => watchUntilNone,
      () => release,
    );

    yield* Ref.set(state.localMinutesWatched, 0);
  });

const performWatchLoop = (
  state: MainState,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError, CampaignStoreTag | TwitchApiTag | ConfigStoreTag | TwitchSocketTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const campaignOpt = yield* Ref.get(state.currentCampaign);

    if (Option.isNone(campaignOpt)) {
      return;
    }

    const campaign = campaignOpt.value;
    const channels = yield* campaignStore.getChannelsForCampaign(campaign);
    const hasNoChannels = channels.length === 0;

    if (hasNoChannels) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red Campaigns offline}`);
      yield* campaignStore.setOffline(campaign.id, true);
      yield* Ref.set(state.currentChannel, Option.none());
      return;
    }

    const drops = yield* campaignStore.getDropsForCampaign(campaign.id);
    yield* Effect.logInfo(chalk`${campaign.name} | {yellow Found ${drops.length} drops / ${channels.length} channels}`);

    for (const channel of channels) {
      const dropOpt = yield* Ref.get(state.currentDrop);
      const isDone = Option.isSome(dropOpt) && isMinutesWatchedMet(dropOpt.value);

      if (isDone) {
        break;
      }

      yield* processChannelWatch(state, campaign, channel);
    }
    yield* Ref.set(state.currentChannel, Option.none());
  });

const tryClaim = (state: MainState, drop: Drop): Effect.Effect<boolean, TwitchApiError, TwitchApiTag | CampaignStoreTag> =>
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const campaignStore = yield* CampaignStoreTag;
    const currentDropOpt = yield* Ref.get(state.currentDrop);

    if (Option.isNone(currentDropOpt)) {
      return false;
    }

    const currentDrop = currentDropOpt.value;
    const claimRes = yield* api.claimDrops(currentDrop.dropInstanceID ?? '').pipe(Effect.option);

    if (Option.isNone(claimRes)) {
      return false;
    }

    if (!claimRes.value.claimDropRewards) {
      return false;
    }

    yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Drops claimed}`);

    const rewards = [];

    for (const id of drop.benefits) {
      rewards.push({ id, lastAwardedAt: new Date() });
    }

    yield* campaignStore.addRewards(rewards);

    return true;
  });

const processClaimAttempts = (
  state: MainState,
  campaign: Campaign,
  drop: Drop,
  totalAttempts: number,
  attempt: number,
): Effect.Effect<number, TwitchApiError, CampaignStoreTag | TwitchApiTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    if (attempt > 0 || !drop.dropInstanceID) {
      yield* campaignStore.updateProgress;

      const drops = yield* campaignStore.getDropsForCampaign(campaign.id);
      const updatedDrop = drops.find((p) => p.id === drop.id);

      if (updatedDrop) {
        yield* Ref.set(state.currentDrop, Option.some(updatedDrop));
      }
    }

    const claimed = yield* tryClaim(state, drop);

    if (claimed) {
      return totalAttempts;
    }

    const currentDropOpt = yield* Ref.get(state.currentDrop);

    if (Option.isNone(currentDropOpt)) {
      return totalAttempts;
    }

    const currentDrop = currentDropOpt.value;
    if (currentDrop.currentMinutesWatched < currentDrop.requiredMinutesWatched) {
      const isBroken = currentDrop.requiredMinutesWatched - currentDrop.currentMinutesWatched >= 20;
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red ${isBroken ? 'Possible broken drops' : 'Minutes not met'}}`);

      if (isBroken) {
        yield* campaignStore.setBroken(currentDrop.campaignId, true);
        yield* resetChannel(state);
        return totalAttempts;
      }

      yield* Ref.set(state.currentChannel, Option.none());
      return totalAttempts;
    }

    if (attempt >= totalAttempts - 1) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found after ${totalAttempts} minutes}`);

      yield* Ref.update(
        state.currentDrop,
        Option.map((dr) => ({ ...dr, hasPreconditionsMet: false })),
      );

      return attempt + 1;
    }

    if (attempt === 0) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found}`);
    }

    yield* Effect.logInfo(chalk`{yellow Waiting for ${attempt + 1}/${totalAttempts} minutes}`);
    yield* Effect.sleep('1 minute');

    return attempt + 1;
  });

const performClaimDrops = (state: MainState, campaign: Campaign, drop: Drop): Effect.Effect<void, TwitchApiError, CampaignStoreTag | TwitchApiTag> =>
  Effect.acquireUseRelease(
    Ref.set(state.isClaiming, true),
    () => {
      const totalAttempts = 5;
      return Effect.iterate(0, {
        while: (attempt) => attempt < totalAttempts,
        body: (attempt) => processClaimAttempts(state, campaign, drop, totalAttempts, attempt),
      });
    },
    () => Ref.set(state.isClaiming, false),
  );

const initializeCampaignState = (state: MainState): Effect.Effect<void, never, CampaignStoreTag | ConfigStoreTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const configStore = yield* ConfigStoreTag;
    const currentState = yield* Ref.get(campaignStore.state);
    const isAlreadyInitialized = currentState._tag !== 'Initial';

    if (isAlreadyInitialized) {
      return;
    }

    yield* campaignStore.updateCampaigns.pipe(Effect.orDie);
    yield* campaignStore.updateProgress.pipe(Effect.orDie);

    const config = yield* configStore.get;
    const campaigns = yield* campaignStore.getSortedActive;
    const priorities = campaigns.filter((c) => config.priorityList.has(c.game.displayName));

    const hasPriority = priorities.length > 0;
    const activeList = hasPriority ? priorities : campaigns;
    yield* Effect.logInfo(chalk`{bold.yellow Checking ${activeList.length} ${hasPriority ? '' : 'Non-'}Priority game!}`);

    yield* Ref.set(campaignStore.state, hasPriority ? CampaignStoreState.PriorityOnly() : CampaignStoreState.All());
    yield* Ref.set(state.isClaiming, false);
  });

const handleNoActiveCampaigns = (): Effect.Effect<void, never, CampaignStoreTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const currentState = yield* Ref.get(campaignStore.state);
    yield* Ref.set(campaignStore.state, CampaignStoreState.Initial());

    if (currentState._tag === 'PriorityOnly') {
      return;
    }

    yield* Effect.logInfo(chalk`{yellow No active campaigns. Checking upcoming...}`);
    yield* Effect.logInfo('');
    yield* Effect.sleep('10 minutes');
  });

const refreshCampaignAndDrops = (
  state: MainState,
  activeCampaign: Campaign,
): Effect.Effect<{ campaign: Campaign; drops: ReadonlyArray<Drop> }, TwitchApiError, CampaignStoreTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    let campaign = activeCampaign;
    yield* Ref.set(state.currentCampaign, Option.some(campaign));
    yield* campaignStore.updateProgress;

    const drops = yield* campaignStore.getDropsForCampaign(campaign.id);
    const campaignsMap = yield* Ref.get(campaignStore.campaigns);
    const updatedCampaign = campaignsMap.get(campaign.id);

    if (updatedCampaign) {
      campaign = updatedCampaign;
      yield* Ref.set(state.currentCampaign, Option.some(campaign));
    }

    return { campaign, drops };
  });

const processCampaignLogic = (
  state: MainState,
  campaign: Campaign,
  drops: ReadonlyArray<Drop>,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError, TwitchApiTag | ConfigStoreTag | TwitchSocketTag | CampaignStoreTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const configStore = yield* ConfigStoreTag;
    const config = yield* configStore.get;
    const hasNoDrops = drops.length === 0;

    if (hasNoDrops) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red No active drops}`);
      yield* campaignStore.setOffline(campaign.id, true);
      return;
    }

    const campaignStatus = getDropStatus(campaign.startAt, campaign.endAt, Date.now());

    if (campaignStatus.isExpired) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red Campaigns expired}`);
      yield* campaignStore.updateCampaigns;
      return;
    }

    const drop = drops[0];
    yield* Ref.set(state.currentDrop, Option.some(drop));

    if (!drop.hasPreconditionsMet) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Preconditions drops}`);
      yield* campaignStore.setOffline(campaign.id, true);
      return;
    }

    const isCompleted = isMinutesWatchedMet(drop);

    if (isCompleted && config.isClaimDrops) {
      yield* performClaimDrops(state, campaign, drop);
      return;
    }

    if (isCompleted) {
      yield* Ref.set(state.currentCampaign, Option.none());
      return;
    }

    yield* performWatchLoop(state);
  });

const processActiveCampaigns = (
  state: MainState,
  activeCampaign: Campaign,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError, CampaignStoreTag | TwitchApiTag | ConfigStoreTag | TwitchSocketTag> =>
  Effect.gen(function* () {
    const { campaign, drops } = yield* refreshCampaignAndDrops(state, activeCampaign);
    yield* processCampaignLogic(state, campaign, drops);
  });

const mainLoop = (
  state: MainState,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError, CampaignStoreTag | TwitchApiTag | ConfigStoreTag | TwitchSocketTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const api = yield* TwitchApiTag;

    yield* initializeCampaignState(state);

    const activeList = yield* campaignStore.getSortedActive;
    if (activeList.length === 0) {
      yield* handleNoActiveCampaigns();
      return;
    }

    const first = activeList[0];

    const channelOpt = yield* Ref.get(state.currentChannel);

    if (Option.isSome(channelOpt)) {
      const channel = channelOpt.value;
      yield* claimChannelPoints(channel);
    } else {
      for (const campaign of activeList) {
        const channels = yield* campaignStore.getChannelsForCampaign(campaign);

        if (channels.length > 0) {
          const firstChannel = channels[0];
          yield* api.channelPoints(firstChannel.login).pipe(Effect.ignore);
          break;
        }
      }
    }

    yield* processActiveCampaigns(state, first);
  });

const ensureSettingsDir = Effect.gen(function* () {
  const settingsDir = 'sessions';
  yield* Effect.tryPromise({
    try: () => mkdir(settingsDir, { recursive: true }),
    catch: (e) => new MainWorkflowError({ message: 'Failed to create sessions directory', cause: e }),
  }).pipe(Effect.catchAll(() => Effect.void));
});

export const MainWorkflow: Effect.Effect<void, RuntimeRestart, CampaignStoreTag | TwitchApiTag | ConfigStoreTag | TwitchSocketTag | Scope.Scope> =
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const socket = yield* TwitchSocketTag;

    yield* ensureSettingsDir as Effect.Effect<void, never, never>;

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

    yield* socket.listen(WsTopic.UserDrop, userId).pipe(Effect.orDie);
    yield* socket.listen(WsTopic.UserPoint, userId).pipe(Effect.orDie);

    yield* SocketWorkflow(state).pipe(Effect.orDie);

    const mainTaskLoop = () =>
      Effect.gen(function* () {
        yield* mainLoop(state).pipe(Effect.orDie);
        yield* Effect.sleep('10 seconds');
      }).pipe(Effect.repeat(Schedule.forever));

    const claimInventoryLoop = () =>
      api.claimAllDropsFromInventory.pipe(Effect.ignore, Effect.zipRight(Effect.sleep('30 minutes')), Effect.repeat(Schedule.forever));

    yield* Effect.all([mainTaskLoop(), claimInventoryLoop(), UpcomingWorkflow(state), OfflineWorkflow(state), cycleUntilMidnight], {
      concurrency: 'unbounded',
    });
  });
