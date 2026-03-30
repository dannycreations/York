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

const resetChannel = (state: MainState): Effect.Effect<void, never, TwitchSocketTag> =>
  Effect.gen(function* () {
    const socket = yield* TwitchSocketTag;
    const curOpt = yield* Ref.get(state.currentChannel);

    if (Option.isSome(curOpt)) {
      const chan = curOpt.value;
      const topics = [WsTopic.ChannelStream, WsTopic.ChannelMoment, WsTopic.ChannelUpdate, WsTopic.ChannelPoint] as const;
      yield* Effect.forEach(topics, (topic) => socket.unlisten(topic, chan.id), { concurrency: 'unbounded', discard: true }).pipe(
        Effect.catchAllCause(() => Effect.void),
      );
    }

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
    const availableClaim = channelData.community.channel.self.communityPoints.availableClaim;

    if (!availableClaim) {
      return;
    }

    yield* api.claimPoints(channel.id, availableClaim.id);
    yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
  });

const updateChannelInfo = (
  state: MainState,
  chan: Channel,
): Effect.Effect<Option.Option<Channel>, MainWorkflowError, TwitchApiTag | TwitchSocketTag> =>
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
        onSome: (c) => {
          if (c.id === updated.id) {
            return Option.some(updated);
          }
          return current;
        },
      }),
    );

    return Option.some(updated);
  });

const attemptClaimDrop = (
  state: MainState,
  campaign: Campaign,
  drop: Drop,
  attempt: number,
): Effect.Effect<number, never, CampaignStoreTag | TwitchApiTag | TwitchSocketTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const api = yield* TwitchApiTag;

    const currentDropInitial = yield* Ref.get(state.currentDrop);
    if (Option.isSome(currentDropInitial) && currentDropInitial.value.isClaimed) {
      return 5;
    }

    if (attempt > 0 || !drop.dropInstanceID) {
      yield* campaignStore.updateProgress.pipe(Effect.orDie);
      const drops = yield* campaignStore.getDropsForCampaign(campaign.id).pipe(Effect.orDie);
      const updatedDrop = drops.find((p) => p.id === drop.id);
      if (updatedDrop) {
        yield* Ref.update(state.currentDrop, (current) =>
          Option.map(current, (cur) => ({
            ...updatedDrop,
            currentMinutesWatched: Math.max(cur.currentMinutesWatched, updatedDrop.currentMinutesWatched),
          })),
        );
      }
    }

    const curDropOpt = yield* Ref.get(state.currentDrop);
    if (Option.isSome(curDropOpt)) {
      if (curDropOpt.value.isClaimed) {
        return 5;
      }

      if (!!curDropOpt.value.dropInstanceID) {
        const claimRes = yield* api.claimDrops(curDropOpt.value.dropInstanceID).pipe(Effect.option, Effect.orDie);
        if (Option.isSome(claimRes) && claimRes.value.claimDropRewards) {
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Drops claimed}`);
          yield* campaignStore.addRewards(drop.benefits.map((id) => ({ id, lastAwardedAt: new Date() }))).pipe(Effect.orDie);
          yield* Ref.update(
            state.currentDrop,
            Option.map((d) => ({ ...d, isClaimed: true })),
          );
          return 5;
        }
      }
    }

    const dropCheckOpt = yield* Ref.get(state.currentDrop);
    if (Option.isNone(dropCheckOpt)) {
      return 5;
    }

    const dropCheck = dropCheckOpt.value;

    if (dropCheck.currentMinutesWatched < dropCheck.requiredMinutesWatched) {
      const isBroken = dropCheck.requiredMinutesWatched - dropCheck.currentMinutesWatched >= 20;
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red ${isBroken ? 'Possible broken drops' : 'Minutes not met'}}`);

      if (isBroken) {
        yield* campaignStore.setBroken(dropCheck.campaignId, true);
        yield* resetChannel(state);
        return 5;
      }

      yield* resetChannel(state);
      return 5;
    }

    if (attempt === 0) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found}`);
    }

    if (attempt >= 5) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found after 5 minutes}`);
      yield* campaignStore.setBroken(campaign.id, true);
      yield* resetChannel(state);
      return 5;
    }

    yield* Effect.logInfo(chalk`{yellow Waiting for ${attempt + 1}/5 minutes for claim ID}`);
    yield* Effect.sleep('1 minute');
    return attempt + 1;
  });

const contributeToCommunityGoal = (
  state: MainState,
  chan: Channel,
): Effect.Effect<void, TwitchApiError | MainWorkflowError, TwitchApiTag | ConfigStoreTag> =>
  Effect.gen(function* () {
    const configStore = yield* ConfigStoreTag;
    const config = yield* configStore.get;

    if (!config.isClaimPoints) {
      return;
    }

    const nextContribution = yield* Ref.get(state.nextCommunityGoalContribution);
    if (Date.now() < nextContribution) {
      return;
    }

    const api = yield* TwitchApiTag;
    const channelData = yield* api.channelPoints(chan.login);
    const community = channelData.community.channel;
    const balance = community.self.communityPoints.balance;

    if (balance <= 0) {
      return;
    }

    const goals = community.communityPointsSettings.goals.filter((g) => g.status === 'STARTED' && g.isInStock);
    if (goals.length === 0) {
      return;
    }

    const contributionData = yield* api.userPointsContribution(chan.login);
    const userContributions = contributionData.user.channel.self.communityPoints.goalContributions;

    for (const goal of goals) {
      const userContrib = userContributions.find((uc) => uc.goal.id === goal.id);
      const amount = Math.min(
        goal.amountNeeded - goal.pointsContributed,
        goal.perStreamUserMaximumContribution - (userContrib?.userPointsContributedThisStream ?? 0),
        balance,
      );

      if (amount <= 0) {
        continue;
      }

      yield* api.contributeCommunityGoal(chan.id, goal.id, amount);
      yield* Effect.logInfo(chalk`{green ${chan.login}} | {yellow Contributed ${amount} points to goal: ${goal.title}}`);
    }

    yield* Ref.set(state.nextCommunityGoalContribution, Date.now() + 300_000);
  });

const mainLoop = (
  state: MainState,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError, CampaignStoreTag | TwitchApiTag | ConfigStoreTag | TwitchSocketTag> =>
  Effect.gen(function* () {
    const campaignStore = yield* CampaignStoreTag;
    const configStore = yield* ConfigStoreTag;
    const api = yield* TwitchApiTag;
    const socket = yield* TwitchSocketTag;

    const campaignState = yield* Ref.get(campaignStore.state);

    if (campaignState._tag === 'Initial') {
      yield* campaignStore.updateCampaigns.pipe(Effect.orDie);
      yield* campaignStore.updateProgress.pipe(Effect.orDie);

      const config = yield* configStore.get;
      const campaigns = yield* campaignStore.getSortedActive;
      const priorities = campaigns.filter((c) => config.priorityList.has(c.game.displayName));

      const hasPriority = priorities.length > 0;
      const activeList = hasPriority ? priorities : campaigns;

      const priorityMessage = hasPriority ? '' : 'Non-';
      yield* Effect.logInfo(chalk`{bold.yellow Checking ${activeList.length} ${priorityMessage}Priority game!}`);

      const nextState = hasPriority ? CampaignStoreState.PriorityOnly() : CampaignStoreState.All();
      yield* Ref.set(campaignStore.state, nextState);
      yield* Ref.set(state.isClaiming, false);
    }

    const activeList = yield* campaignStore.getSortedActive;

    if (activeList.length === 0) {
      const currentState = yield* Ref.get(campaignStore.state);
      yield* Ref.set(campaignStore.state, CampaignStoreState.Initial());

      if (currentState._tag !== 'PriorityOnly') {
        yield* Effect.logInfo(chalk`{yellow No active campaigns. Checking upcoming...}`);
        yield* Effect.logInfo('');
        yield* Effect.sleep('10 minutes');
      }

      return;
    }

    const channelOpt = yield* Ref.get(state.currentChannel);
    if (Option.isSome(channelOpt)) {
      yield* claimChannelPoints(channelOpt.value);
    } else {
      for (const campaign of activeList) {
        const channels = yield* campaignStore.getChannelsForCampaign(campaign);

        if (channels.length > 0) {
          yield* api.channelPoints(channels[0].login).pipe(Effect.ignore);
          break;
        }
      }
    }

    const prevCampaignOpt = yield* Ref.get(state.currentCampaign);
    const oldDropOpt = yield* Ref.get(state.currentDrop);

    let campaign = activeList[0];
    const isSameCampaign = Option.isSome(prevCampaignOpt) && prevCampaignOpt.value.id === campaign.id;

    yield* Ref.set(state.currentCampaign, Option.some(campaign));

    if (!isSameCampaign || Option.isNone(oldDropOpt)) {
      yield* campaignStore.updateProgress;
    }

    const drops = yield* campaignStore.getDropsForCampaign(campaign.id);
    const campaignsMap = yield* Ref.get(campaignStore.campaigns);
    const updatedCampaign = campaignsMap.get(campaign.id);

    if (updatedCampaign) {
      campaign = updatedCampaign;
      yield* Ref.set(state.currentCampaign, Option.some(campaign));
    }

    const config = yield* configStore.get;

    if (drops.length === 0) {
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

    let drop = drops[0];

    if (Option.isSome(oldDropOpt) && oldDropOpt.value.id === drop.id) {
      drop = {
        ...drop,
        currentMinutesWatched: Math.max(drop.currentMinutesWatched, oldDropOpt.value.currentMinutesWatched),
      };
    }

    yield* Ref.set(state.currentDrop, Option.some(drop));

    if (!drop.hasPreconditionsMet) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Preconditions not met}`);
      yield* campaignStore.setOffline(campaign.id, true);
      yield* resetChannel(state);
      return;
    }

    if (isMinutesWatchedMet(drop)) {
      if (!config.isClaimDrops) {
        yield* Ref.set(state.currentCampaign, Option.none());
        return;
      }

      yield* Effect.acquireUseRelease(
        Ref.set(state.isClaiming, true),
        () =>
          Effect.iterate(0, {
            while: (attempt) => attempt < 5,
            body: (attempt) => attemptClaimDrop(state, campaign, drop, attempt),
          }),
        () => Ref.set(state.isClaiming, false),
      );

      return;
    }

    const channels = yield* campaignStore.getChannelsForCampaign(campaign);
    if (channels.length === 0) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red Campaigns offline}`);
      yield* campaignStore.setOffline(campaign.id, true);
      yield* resetChannel(state);
      return;
    }

    const topics = [WsTopic.ChannelStream, WsTopic.ChannelMoment, WsTopic.ChannelUpdate, WsTopic.ChannelPoint] as const;
    const currentChannelOpt = yield* Ref.get(state.currentChannel);

    if (Option.isNone(currentChannelOpt)) {
      yield* Effect.logInfo(chalk`${campaign.name} | {yellow Found ${drops.length} drops / ${channels.length} channels}`);
    }

    let targetChannels = channels;

    if (Option.isSome(currentChannelOpt)) {
      const curChan = currentChannelOpt.value;
      if (channels.some((c) => c.id === curChan.id)) {
        targetChannels = [curChan, ...channels.filter((c) => c.id !== curChan.id)];
      }
    }

    for (const channel of targetChannels) {
      const dropOpt = yield* Ref.get(state.currentDrop);

      if (Option.isSome(dropOpt) && isMinutesWatchedMet(dropOpt.value)) {
        break;
      }

      yield* Ref.set(state.currentChannel, Option.some(channel));
      const chanOpt = yield* updateChannelInfo(state, channel);

      if (Option.isNone(chanOpt)) {
        continue;
      }

      const chan = chanOpt.value;
      yield* claimChannelPoints(chan);
      yield* contributeToCommunityGoal(state, chan);

      yield* Effect.gen(function* () {
        const isClaiming = yield* Ref.get(state.isClaiming);

        if (isClaiming) {
          yield* Effect.sleep('5 seconds');
          return;
        }

        const activeCampaigns = yield* campaignStore.getSortedActive;
        const higherPriority = activeCampaigns[0];
        const curDropOpt = yield* Ref.get(state.currentDrop);

        const isDifferentCampaign = higherPriority && higherPriority.id !== campaign.id;
        const hasHigherPriority = higherPriority && higherPriority.priority > campaign.priority;
        const isDifferentGame = Option.isSome(curDropOpt) && higherPriority && higherPriority.game.id !== campaign.game.id;
        const dropEndsLater = Option.isSome(curDropOpt) && higherPriority && curDropOpt.value.endAt >= higherPriority.endAt;

        const shouldSwitch = isDifferentCampaign && (hasHigherPriority || (isDifferentGame && dropEndsLater));

        if (shouldSwitch) {
          yield* Effect.logInfo(chalk`{yellow Switching to higher priority campaign: ${higherPriority.name}}`);
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
        const updatedCurChanOpt = yield* updateChannelInfo(state, curChan);

        if (Option.isNone(updatedCurChanOpt)) {
          return;
        }

        const updatedCurChan = updatedCurChanOpt.value;
        const isGameChanged = !!updatedCurChan.gameId && !!updatedCurChan.currentGameId && updatedCurChan.gameId !== updatedCurChan.currentGameId;

        if (isGameChanged) {
          yield* Effect.logInfo(chalk`{red ${updatedCurChan.login}} | {red Game changed to ${updatedCurChan.currentGameName}}`);
          yield* resetChannel(state);
          return;
        }

        const { success, hlsUrl } = yield* api.watch(updatedCurChan);

        if (hlsUrl !== updatedCurChan.hlsUrl) {
          yield* Ref.update(
            state.currentChannel,
            Option.map((c) => {
              if (c.id === updatedCurChan.id) {
                return { ...c, hlsUrl };
              }
              return c;
            }),
          );
        }

        const watchTimeNotReached = Date.now() < (yield* Ref.get(state.nextWatch));

        if (watchTimeNotReached) {
          return;
        }

        if (!success) {
          yield* resetChannel(state);
          return;
        }

        yield* Ref.update(state.localMinutesWatched, (m) => m + 1);
        yield* Ref.set(state.nextWatch, Date.now() + 60_000);

        const dropCheckOpt = yield* Ref.get(state.currentDrop);

        if (Option.isNone(dropCheckOpt)) {
          return;
        }

        const dropCheck = dropCheckOpt.value;
        const currentMinutesWatched = dropCheck.currentMinutesWatched + 1;

        yield* Effect.logInfo(
          chalk`{green ${dropCheck.name}} | {green ${updatedCurChan.login}} | {green ${currentMinutesWatched}/${dropCheck.requiredMinutesWatched}}`,
        );

        const updatedDropState = { ...dropCheck, currentMinutesWatched };
        yield* Ref.set(state.currentDrop, Option.some(updatedDropState));

        if (isMinutesWatchedMet(updatedDropState)) {
          yield* Effect.logInfo(
            chalk`{green ${dropCheck.name}} | {green Completed!} | {green ${currentMinutesWatched}/${dropCheck.requiredMinutesWatched}}`,
          );
          yield* Effect.acquireUseRelease(
            Ref.set(state.isClaiming, true),
            () =>
              Effect.iterate(0, {
                while: (attempt) => attempt < 5,
                body: (attempt) => attemptClaimDrop(state, campaign, updatedDropState, attempt),
              }),
            () => Ref.set(state.isClaiming, false),
          );

          yield* resetChannel(state);
          return;
        }

        yield* Effect.forEach(topics, (topic) => socket.listen(topic, updatedCurChan.id), { concurrency: 'unbounded', discard: true });

        const localMin = yield* Ref.get(state.localMinutesWatched);

        if (localMin < 20) {
          return;
        }

        yield* Ref.set(state.localMinutesWatched, 0);
        yield* campaignStore.updateProgress;

        const freshDrops = yield* campaignStore.getDropsForCampaign(dropCheck.campaignId);
        const freshDrop = freshDrops.find((d) => d.id === dropCheck.id);

        if (!freshDrop) {
          return;
        }

        const isBrokenLocal = currentMinutesWatched - freshDrop.currentMinutesWatched >= 20;

        if (isBrokenLocal) {
          yield* Ref.update(
            state.currentChannel,
            Option.map((ch) => ({ ...ch, isOnline: false })),
          );
        }

        yield* Ref.set(state.currentDrop, Option.some(freshDrop));
      });

      const currentChannelPostWatch = yield* Ref.get(state.currentChannel);

      if (Option.isNone(currentChannelPostWatch)) {
        yield* Ref.set(state.localMinutesWatched, 0);
        continue;
      }

      return;
    }

    yield* resetChannel(state);
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

    const mainTaskLoop = () => mainLoop(state).pipe(Effect.orDie, Effect.repeat(Schedule.forever));

    const claimInventoryLoop = () =>
      api.claimAllDropsFromInventory.pipe(Effect.ignore, Effect.zipRight(Effect.sleep('30 minutes')), Effect.repeat(Schedule.forever));

    yield* Effect.all([mainTaskLoop(), claimInventoryLoop(), UpcomingWorkflow(state), OfflineWorkflow(state), cycleUntilMidnight], {
      concurrency: 'unbounded',
    });
  });
