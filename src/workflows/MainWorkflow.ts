import { mkdir } from 'node:fs/promises';
import { chalk } from '@vegapunk/utilities';
import { Data, Effect, Option, Ref, Schedule, Scope } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { WsTopic } from '../core/Constants';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper';
import { TwitchApiTag } from '../services/TwitchApi';
import { TwitchSocketTag } from '../services/TwitchSocket';
import { WatchServiceTag } from '../services/WatchService';
import { CampaignStoreTag } from '../stores/CampaignStore';
import { cycleMidnightRestart } from '../structures/RuntimeClient';
import { OfflineWorkflow } from './OfflineWorkflow';
import { SocketWorkflow } from './SocketWorkflow';
import { UpcomingWorkflow } from './UpcomingWorkflow';

import type { ClientConfig } from '../core/Config';
import type { Campaign, Channel, Drop } from '../core/Schemas';
import type { TwitchApi, TwitchApiError } from '../services/TwitchApi';
import type { TwitchSocket, TwitchSocketError } from '../services/TwitchSocket';
import type { WatchError, WatchService } from '../services/WatchService';
import type { CampaignStore } from '../stores/CampaignStore';
import type { RuntimeRestart } from '../structures/RuntimeClient';
import type { StoreClient } from '../structures/StoreClient';

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
}

const resetChannel = (state: MainState): Effect.Effect<void> =>
  Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false }))).pipe(
    Effect.zipRight(Ref.set(state.currentChannel, Option.none())),
  );

const claimChannelPoints = (channel: Channel, api: TwitchApi, configStore: StoreClient<ClientConfig>): Effect.Effect<void, TwitchApiError> =>
  Effect.gen(function* () {
    const config = yield* configStore.get;
    if (!config.isClaimPoints) return;

    const channelData = yield* api.channelPoints(channel.login);
    const availableClaim = channelData.community.channel.self.communityPoints.availableClaim;

    if (availableClaim) {
      yield* api.claimPoints(channel.id, availableClaim.id).pipe(Effect.ignore);
      yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
    }
  });

const checkHigherPriority = (state: MainState, campaign: Campaign, campaignStore: CampaignStore): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const activeCampaigns = yield* campaignStore.getSortedActive;
    if (activeCampaigns.length === 0 || activeCampaigns[0].id === campaign.id) return false;

    const higherPriority = activeCampaigns[0];
    const currentDrop = yield* Ref.get(state.currentDrop);
    const isDifferentGame = higherPriority.game.id !== campaign.game.id;
    const shouldPrioritize = Option.isSome(currentDrop) && isDifferentGame && currentDrop.value.endAt >= higherPriority.endAt;

    if (shouldPrioritize || higherPriority.priority > campaign.priority) {
      yield* Effect.logInfo(chalk`{yellow Switching to higher priority campaign: ${higherPriority.name}}`);
      yield* Ref.set(state.currentChannel, Option.none());
      return true;
    }
    return false;
  });

const updateChannelInfo = (state: MainState, api: TwitchApi, chan: Channel): Effect.Effect<Channel | null, MainWorkflowError> =>
  Effect.gen(function* () {
    if (chan.currentSid && (yield* Ref.get(state.localMinutesWatched)) > 0) return chan;

    const streamRes = yield* api.helixStreams(chan.id).pipe(Effect.mapError((e) => new MainWorkflowError({ message: e.message, cause: e })));

    const live = streamRes.data[0];
    if (!live) {
      yield* resetChannel(state);
      return null;
    }

    const updated = {
      ...chan,
      currentSid: live.id,
      currentGameId: live.game_id,
      currentGameName: live.game_name,
    };
    yield* Ref.set(state.currentChannel, Option.some(updated));
    return updated;
  });

const handleWatchSuccess = (state: MainState, chan: Channel, campaignStore: CampaignStore): Effect.Effect<void, TwitchApiError> =>
  Effect.gen(function* () {
    yield* Ref.update(state.localMinutesWatched, (m) => m + 1);
    yield* Ref.set(state.nextWatch, Date.now() + 60_000);

    const dropOpt = yield* Ref.get(state.currentDrop);
    if (Option.isSome(dropOpt)) {
      const drop = dropOpt.value;
      const currentMinutesWatched = drop.currentMinutesWatched + 1;
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {green ${chan.login}} | {green ${currentMinutesWatched}/${drop.requiredMinutesWatched}}`);
      yield* Ref.update(state.currentDrop, (d) => Option.map(d, (dr) => ({ ...dr, currentMinutesWatched })));

      if ((yield* Ref.get(state.localMinutesWatched)) >= 20) {
        yield* Ref.set(state.localMinutesWatched, 0);
        yield* campaignStore.updateProgress;
        const drops = yield* campaignStore.getDropsForCampaign(drop.campaignId);
        const updatedDrop = drops.find((d) => d.id === drop.id);
        if (updatedDrop) {
          if (currentMinutesWatched - updatedDrop.currentMinutesWatched >= 20) {
            yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
          }
          yield* Ref.set(state.currentDrop, Option.some(updatedDrop));
        }
      }
    }
  });

const watchChannelTick = (
  state: MainState,
  api: TwitchApi,
  campaignStore: CampaignStore,
  watchService: WatchService,
  campaign: Campaign,
): Effect.Effect<void, TwitchApiError | MainWorkflowError | WatchError> =>
  Effect.gen(function* () {
    if (yield* Ref.get(state.isClaiming)) {
      return yield* Effect.sleep('5 seconds');
    }

    if (yield* checkHigherPriority(state, campaign, campaignStore)) {
      return yield* resetChannel(state);
    }

    const nowMs = Date.now();
    const nextWatchMs = yield* Ref.get(state.nextWatch);
    if (nowMs < nextWatchMs) {
      yield* Effect.sleep(`${nextWatchMs - nowMs} millis`);
    }

    const chanOpt = yield* Ref.get(state.currentChannel);
    if (Option.isNone(chanOpt) || !chanOpt.value.isOnline) {
      return yield* Ref.set(state.currentChannel, Option.none());
    }

    const chan = yield* updateChannelInfo(state, api, chanOpt.value);
    if (!chan) return;

    if (chan.gameId && chan.currentGameId && chan.gameId !== chan.currentGameId) {
      yield* Effect.logInfo(chalk`{red ${chan.login}} | {red Game changed to ${chan.currentGameName}}`);
      return yield* resetChannel(state);
    }

    const { success, hlsUrl } = yield* watchService.watch(chan);
    if (hlsUrl !== chan.hlsUrl) {
      yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, hlsUrl })));
    }

    const currentTimeMs = Date.now();
    const scheduledWatchMs = yield* Ref.get(state.nextWatch);
    if (currentTimeMs >= scheduledWatchMs) {
      if (success) {
        yield* handleWatchSuccess(state, chan, campaignStore);
      } else {
        return yield* resetChannel(state);
      }
    }

    yield* Effect.sleep('1 minute');
  });

const manageChannelSockets = (
  socket: TwitchSocket,
  channelId: string,
): {
  readonly acquire: Effect.Effect<void[], TwitchSocketError>;
  readonly release: Effect.Effect<void>;
} => {
  const topics = [WsTopic.ChannelStream, WsTopic.ChannelMoment, WsTopic.ChannelUpdate];

  const acquire = Effect.all(
    topics.map((topic) => socket.listen(topic, channelId)),
    { concurrency: 'unbounded' },
  );

  const release = Effect.all(
    topics.map((topic) => socket.unlisten(topic, channelId)),
    { concurrency: 'unbounded' },
  ).pipe(Effect.catchAllCause(() => Effect.void));

  return { acquire, release };
};

const processChannelWatch = (
  state: MainState,
  api: TwitchApi,
  socket: TwitchSocket,
  campaignStore: CampaignStore,
  watchService: WatchService,
  configStore: StoreClient<ClientConfig>,
  campaign: Campaign,
  channel: Channel,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError | WatchError> =>
  Effect.gen(function* () {
    yield* Ref.set(state.currentChannel, Option.some(channel));

    yield* claimChannelPoints(channel, api, configStore);

    const { acquire, release } = manageChannelSockets(socket, channel.id);

    yield* Effect.acquireUseRelease(
      acquire,
      () =>
        Effect.repeat(watchChannelTick(state, api, campaignStore, watchService, campaign), {
          until: () => Ref.get(state.currentChannel).pipe(Effect.map(Option.isNone)),
        }),
      () => release,
    );

    yield* Ref.set(state.localMinutesWatched, 0);
  });

const performWatchLoop = (
  state: MainState,
  api: TwitchApi,
  socket: TwitchSocket,
  campaignStore: CampaignStore,
  watchService: WatchService,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError | WatchError> =>
  Effect.gen(function* () {
    const campaignOpt = yield* Ref.get(state.currentCampaign);
    if (Option.isNone(campaignOpt)) return;
    const campaign = campaignOpt.value;

    const channels = yield* campaignStore.getChannelsForCampaign(campaign);
    if (channels.length === 0) {
      yield* Effect.logInfo(chalk`${campaign.name} | {red Campaigns offline}`);
      yield* campaignStore.setOffline(campaign.id, true);
      yield* Ref.set(state.currentChannel, Option.none());
      return;
    }

    const drops = yield* campaignStore.getDropsForCampaign(campaign.id);
    yield* Effect.logInfo(chalk`${campaign.name} | {yellow Found ${drops.length} drops / ${channels.length} channels}`);

    yield* Effect.forEach(
      channels,
      (channel) => processChannelWatch(state, api, socket, campaignStore, watchService, configStore, campaign, channel),
      { discard: true, concurrency: 1 },
    );
    yield* Ref.set(state.currentChannel, Option.none());
  });

const tryClaim = (state: MainState, api: TwitchApi, campaignStore: CampaignStore, drop: Drop): Effect.Effect<boolean, TwitchApiError> =>
  Effect.gen(function* () {
    const currentDropOpt = yield* Ref.get(state.currentDrop);
    if (Option.isNone(currentDropOpt)) return false;

    const currentDrop = currentDropOpt.value;
    const claimRes = yield* api.claimDrops(currentDrop.dropInstanceID ?? '').pipe(Effect.option);

    if (Option.isSome(claimRes) && claimRes.value.claimDropRewards) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Drops claimed}`);
      yield* campaignStore.addRewards(drop.benefits.map((id) => ({ id, lastAwardedAt: new Date() })));
      return true;
    }
    return false;
  });

const processClaimAttempts = (
  state: MainState,
  api: TwitchApi,
  campaignStore: CampaignStore,
  campaign: Campaign,
  drop: Drop,
  totalAttempts: number,
  attempt: number,
): Effect.Effect<number, TwitchApiError> =>
  Effect.gen(function* () {
    if (attempt > 0 || !drop.dropInstanceID) {
      yield* campaignStore.updateProgress;
      const drops = yield* campaignStore.getDropsForCampaign(campaign.id);
      const updatedDrop = drops.find((p) => p.id === drop.id);
      if (updatedDrop) {
        yield* Ref.set(state.currentDrop, Option.some(updatedDrop));
      }
    }

    const claimed = yield* tryClaim(state, api, campaignStore, drop);
    if (claimed) return totalAttempts;

    const currentDropOpt = yield* Ref.get(state.currentDrop);
    if (Option.isNone(currentDropOpt)) return totalAttempts;
    const currentDrop = currentDropOpt.value;

    if (currentDrop.currentMinutesWatched < currentDrop.requiredMinutesWatched) {
      const isBroken = currentDrop.requiredMinutesWatched - currentDrop.currentMinutesWatched >= 20;
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red ${isBroken ? 'Possible broken drops' : 'Minutes not met'}}`);

      if (isBroken) {
        yield* resetChannel(state);
      } else {
        yield* Ref.set(state.currentChannel, Option.none());
      }

      return totalAttempts;
    }

    if (attempt < totalAttempts - 1) {
      if (attempt === 0) {
        yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found}`);
      }
      yield* Effect.logInfo(chalk`{yellow Waiting for ${attempt + 1}/${totalAttempts} minutes}`);
      yield* Effect.sleep('1 minute');
    } else {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found after ${totalAttempts} minutes}`);
      yield* Ref.update(state.currentDrop, (d) => Option.map(d, (dr) => ({ ...dr, hasPreconditionsMet: false })));
    }

    return attempt + 1;
  });

const performClaimDrops = (
  state: MainState,
  api: TwitchApi,
  campaignStore: CampaignStore,
  campaign: Campaign,
  drop: Drop,
): Effect.Effect<void, TwitchApiError> =>
  Effect.acquireUseRelease(
    Ref.set(state.isClaiming, true),
    () => {
      const totalAttempts = 5;
      return Effect.iterate(0, {
        while: (attempt) => attempt < totalAttempts,
        body: (attempt) => processClaimAttempts(state, api, campaignStore, campaign, drop, totalAttempts, attempt),
      });
    },
    () => Ref.set(state.isClaiming, false),
  );

const initializeCampaignState = (state: MainState, campaignStore: CampaignStore, configStore: StoreClient<ClientConfig>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const currentState = yield* Ref.get(campaignStore.state);
    if (currentState !== 'Initial') return;

    yield* campaignStore.updateCampaigns.pipe(Effect.orDie);
    yield* campaignStore.updateProgress.pipe(Effect.orDie);

    const config = yield* configStore.get;
    const campaigns = yield* campaignStore.getSortedActive;
    const priorities = campaigns.filter((c) => config.priorityList.has(c.game.displayName));

    const hasPriority = priorities.length > 0;
    const activeList = hasPriority ? priorities : campaigns;
    yield* Effect.logInfo(chalk`{bold.yellow Checking ${activeList.length} ${hasPriority ? '' : 'Non-'}Priority game!}`);

    yield* Ref.set(campaignStore.state, hasPriority ? 'PriorityOnly' : 'All');
    yield* Ref.set(state.isClaiming, false);
  });

const handleNoActiveCampaigns = (campaignStore: CampaignStore): Effect.Effect<void> =>
  Effect.gen(function* () {
    const currentState = yield* Ref.get(campaignStore.state);
    if (currentState === 'PriorityOnly') {
      yield* Ref.set(campaignStore.state, 'All');
      return;
    }
    yield* Ref.set(campaignStore.state, 'Initial');
    yield* Effect.logInfo(chalk`{yellow No active campaigns. Checking upcoming...}`);
    yield* Effect.logInfo('');
    yield* Effect.sleep('10 minutes');
  });

const refreshCampaignAndDrops = (
  state: MainState,
  campaignStore: CampaignStore,
  activeCampaign: Campaign,
): Effect.Effect<{ campaign: Campaign; drops: ReadonlyArray<Drop> }, TwitchApiError> =>
  Effect.gen(function* () {
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
  api: TwitchApi,
  socket: TwitchSocket,
  campaignStore: CampaignStore,
  watchService: WatchService,
  configStore: StoreClient<ClientConfig>,
  campaign: Campaign,
  drops: ReadonlyArray<Drop>,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError | WatchError> =>
  Effect.gen(function* () {
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

    const drop = drops[0];
    yield* Ref.set(state.currentDrop, Option.some(drop));

    if (!drop.hasPreconditionsMet) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Preconditions drops}`);
      yield* campaignStore.setOffline(campaign.id, true);
      return;
    }

    if (isMinutesWatchedMet(drop)) {
      if ((yield* configStore.get).isClaimDrops) {
        yield* performClaimDrops(state, api, campaignStore, campaign, drop);
      } else {
        yield* Ref.update(state.currentCampaign, () => Option.none());
      }
      return;
    }

    yield* performWatchLoop(state, api, socket, campaignStore, watchService, configStore);
    if ((yield* Ref.get(campaignStore.state)) === 'All') {
      yield* Ref.set(campaignStore.state, 'Initial');
    }
  });

const processActiveCampaigns = (
  state: MainState,
  api: TwitchApi,
  socket: TwitchSocket,
  campaignStore: CampaignStore,
  watchService: WatchService,
  configStore: StoreClient<ClientConfig>,
  activeCampaign: Campaign,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError | WatchError> =>
  Effect.gen(function* () {
    const { campaign, drops } = yield* refreshCampaignAndDrops(state, campaignStore, activeCampaign);
    yield* processCampaignLogic(state, api, socket, campaignStore, watchService, configStore, campaign, drops);
  });

const mainLoop = (
  state: MainState,
  api: TwitchApi,
  socket: TwitchSocket,
  campaignStore: CampaignStore,
  watchService: WatchService,
  configStore: StoreClient<ClientConfig>,
): Effect.Effect<void, TwitchApiError | TwitchSocketError | MainWorkflowError | WatchError> =>
  Effect.gen(function* () {
    yield* initializeCampaignState(state, campaignStore, configStore);

    const activeCampaigns = yield* campaignStore.getSortedActive;
    if (activeCampaigns.length === 0) {
      yield* handleNoActiveCampaigns(campaignStore);
      return;
    }

    yield* processActiveCampaigns(state, api, socket, campaignStore, watchService, configStore, activeCampaigns[0]).pipe(Effect.orDie);
  });

const updatePriorities = (campaignStore: CampaignStore, configStore: StoreClient<ClientConfig>): Effect.Effect<void> =>
  Effect.gen(function* () {
    const config = yield* configStore.get;
    yield* Ref.update(campaignStore.campaigns, (map) => {
      const next = new Map(map);
      for (const [id, campaign] of next) {
        next.set(id, { ...campaign, priority: config.priorityList.has(campaign.game.displayName) ? 1 : 0 });
      }
      return next;
    });
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
  CampaignStore | TwitchApi | StoreClient<ClientConfig> | TwitchSocket | WatchService | Scope.Scope
> = Effect.gen(function* () {
  const campaignStore = yield* CampaignStoreTag;
  const api = yield* TwitchApiTag;
  const configStore = yield* ConfigStoreTag;
  const socket = yield* TwitchSocketTag;
  const watchService = yield* WatchServiceTag;

  yield* ensureSettingsDir;

  const state: MainState = {
    currentCampaign: yield* Ref.make<Option.Option<Campaign>>(Option.none()),
    currentChannel: yield* Ref.make<Option.Option<Channel>>(Option.none()),
    currentDrop: yield* Ref.make<Option.Option<Drop>>(Option.none()),
    localMinutesWatched: yield* Ref.make(0),
    nextPointClaim: yield* Ref.make(0),
    nextWatch: yield* Ref.make(0),
    isClaiming: yield* Ref.make(false),
  };

  yield* api.init.pipe(Effect.orDie);
  const userId = yield* api.userId.pipe(Effect.orDie);

  yield* socket.listen(WsTopic.UserDrop, userId).pipe(Effect.orDie);
  yield* socket.listen(WsTopic.UserPoint, userId).pipe(Effect.orDie);

  yield* SocketWorkflow(state, configStore).pipe(Effect.orDie);

  const mainTaskLoop = (): Effect.Effect<void, never, CampaignStore | TwitchApi | StoreClient<ClientConfig> | TwitchSocket | WatchService> =>
    Effect.repeat(
      Effect.gen(function* () {
        yield* updatePriorities(campaignStore, configStore);
        yield* mainLoop(state, api, socket, campaignStore, watchService, configStore).pipe(Effect.orDie);
        yield* Effect.sleep('10 seconds');
      }),
      Schedule.forever,
    ).pipe(Effect.asVoid);

  yield* Effect.all([mainTaskLoop(), UpcomingWorkflow(state), OfflineWorkflow(state, configStore), cycleMidnightRestart], {
    concurrency: 'unbounded',
  });
});
