import { chalk } from '@vegapunk/utilities';
import { Data, Effect, Option, Ref, Schedule, Schema, Scope } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { getDropStatus, HelixStreamsSchema, WsTopic } from '../core/Types';
import { CampaignStoreTag } from '../services/CampaignStore';
import { TwitchApiTag } from '../services/TwitchApi';
import { TwitchSocketTag } from '../services/TwitchSocket';
import { WatchServiceTag } from '../services/WatchService';
import { cycleMidnightRestart, cycleWithRestart } from '../structures/RuntimeClient';
import { OfflineWorkflow } from './OfflineWorkflow';
import { SocketWorkflow } from './SocketWorkflow';
import { UpcomingWorkflow } from './UpcomingWorkflow';

import type { ClientConfig } from '../core/Config';
import type { Campaign, Channel, Drop } from '../core/Types';
import type { CampaignStore } from '../services/CampaignStore';
import type { TwitchApi } from '../services/TwitchApi';
import type { TwitchSocket } from '../services/TwitchSocket';
import type { WatchService } from '../services/WatchService';
import type { StoreClient } from '../structures/StoreClient';

export class MainWorkflowError extends Data.TaggedError('MainWorkflowError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface MainState {
  readonly currentCampaign: Ref.Ref<Option.Option<Campaign>>;
  readonly currentChannel: Ref.Ref<Option.Option<Channel>>;
  readonly currentDrop: Ref.Ref<Option.Option<Drop>>;
  readonly minutesWatched: Ref.Ref<number>;
  readonly nextPointClaim: Ref.Ref<number>;
  readonly nextWatch: Ref.Ref<number>;
  readonly isClaiming: Ref.Ref<boolean>;
}

const performWatchLoop = (
  state: MainState,
  api: TwitchApi,
  socket: TwitchSocket,
  campaignStore: CampaignStore,
  watchService: WatchService,
  configStore: StoreClient<ClientConfig>,
) =>
  Effect.gen(function* () {
    const campaignOpt = yield* Ref.get(state.currentCampaign);
    if (Option.isNone(campaignOpt)) {
      return;
    }
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
      (channel) =>
        Effect.gen(function* () {
          yield* Ref.set(state.currentChannel, Option.some(channel));

          const config = yield* configStore.get;
          const channelData = yield* api.channelPoints(channel.login);
          const availableClaim = channelData.community.channel.self.communityPoints.availableClaim;
          if (availableClaim && config.isClaimPoints) {
            yield* api.claimPoints(channel.id, availableClaim.id);
            yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed}`);
          }

          yield* socket.listen(WsTopic.ChannelStream, channel.id);
          yield* socket.listen(WsTopic.ChannelMoment, channel.id);
          yield* socket.listen(WsTopic.ChannelUpdate, channel.id);

          yield* Effect.repeat(
            Effect.gen(function* () {
              if (yield* Ref.get(state.isClaiming)) {
                yield* Effect.sleep('5 seconds');
                return;
              }

              const activeCampaigns = yield* campaignStore.getSortedActive;
              if (activeCampaigns.length > 0 && activeCampaigns[0].id !== campaign.id) {
                const higherPriority = activeCampaigns[0];
                const currentDrop = yield* Ref.get(state.currentDrop);
                const isDifferentGame = higherPriority.game.id !== campaign.game.id;
                const shouldPrioritize = Option.isSome(currentDrop) && isDifferentGame && currentDrop.value.endAt >= higherPriority.endAt;

                if (shouldPrioritize) {
                  yield* Effect.logInfo(chalk`{yellow Switching to higher priority campaign: ${higherPriority.name}}`);
                  yield* Ref.set(state.currentChannel, Option.none());
                  return;
                }
              }

              const nowMs = Date.now();
              const nextWatchMs = yield* Ref.get(state.nextWatch);
              if (nowMs < nextWatchMs) {
                yield* Effect.sleep(`${nextWatchMs - nowMs} millis`);
              }

              const chanOpt = yield* Ref.get(state.currentChannel);
              if (Option.isNone(chanOpt) || !chanOpt.value.isOnline) {
                yield* Ref.set(state.currentChannel, Option.none());
                return;
              }
              let chan = chanOpt.value;

              if (!chan.currentSid || (yield* Ref.get(state.minutesWatched)) === 0) {
                const streamRes = yield* api
                  .request<unknown>({
                    url: 'https://api.twitch.tv/helix/streams',
                    headers: { 'client-id': 'uaw3vx1k0ttq74u9b2zfvt768eebh1' },
                    searchParams: { user_id: chan.id },
                    responseType: 'json',
                  })
                  .pipe(
                    Effect.flatMap((res) => Schema.decodeUnknown(HelixStreamsSchema)(res.body)),
                    Effect.mapError((e) => new MainWorkflowError({ message: `Helix validation failed: ${e}`, cause: e })),
                  );

                const live = streamRes.data[0];
                if (live) {
                  chan = {
                    ...chan,
                    currentSid: live.id,
                    currentGameId: live.game_id,
                    currentGameName: live.game_name,
                  };
                  yield* Ref.set(state.currentChannel, Option.some(chan));
                } else {
                  yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
                  yield* Ref.set(state.currentChannel, Option.none());
                  return;
                }
              }

              if (chan.gameId && chan.currentGameId && chan.gameId !== chan.currentGameId) {
                yield* Effect.logInfo(chalk`{red ${chan.login}} | {red Game changed to ${chan.currentGameName}}`);
                yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
                yield* Ref.set(state.currentChannel, Option.none());
                return;
              }

              const { success, hlsUrl } = yield* watchService.watch(chan);
              if (hlsUrl !== chan.hlsUrl) {
                yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, hlsUrl })));
              }

              const currentTimeMs = Date.now();
              const scheduledWatchMs = yield* Ref.get(state.nextWatch);
              if (success && currentTimeMs >= scheduledWatchMs) {
                if ((yield* Ref.get(state.minutesWatched)) === 0) {
                  yield* socket.listen(WsTopic.ChannelStream, chan.id);
                  yield* socket.listen(WsTopic.ChannelMoment, chan.id);
                  yield* socket.listen(WsTopic.ChannelUpdate, chan.id);
                }

                yield* Ref.update(state.minutesWatched, (m) => m + 1);
                const nextWatch = Date.now() + 60_000;
                yield* Ref.set(state.nextWatch, nextWatch);

                const dropOpt = yield* Ref.get(state.currentDrop);
                if (Option.isSome(dropOpt)) {
                  const drop = dropOpt.value;
                  yield* Effect.logInfo(
                    chalk`{green ${drop.name}} | {green ${chan.login}} | {green ${drop.currentMinutesWatched + 1}/${drop.requiredMinutesWatched}}`,
                  );
                  yield* Ref.update(state.currentDrop, (d) =>
                    Option.map(d, (dr) => ({ ...dr, currentMinutesWatched: dr.currentMinutesWatched + 1 })),
                  );
                }
              } else if (!success && currentTimeMs >= scheduledWatchMs) {
                const chanOpt = yield* Ref.get(state.currentChannel);
                if (Option.isSome(chanOpt)) {
                  const dropOpt = yield* Ref.get(state.currentDrop);
                  if (Option.isSome(dropOpt)) {
                    const drop = dropOpt.value;
                    if (drop.requiredMinutesWatched - drop.currentMinutesWatched >= 20) {
                      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Possible broken drops}`);
                      yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
                      yield* Ref.set(state.currentChannel, Option.none());
                      return;
                    }
                  }
                  yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
                }
                yield* Ref.set(state.currentChannel, Option.none());
                return;
              }

              const mins = yield* Ref.get(state.minutesWatched);
              if (mins >= 20) {
                yield* Ref.set(state.minutesWatched, 0);
                const oldDropOpt = yield* Ref.get(state.currentDrop);
                yield* campaignStore.updateProgress;
                yield* campaignStore.updateCampaigns;

                if (Option.isSome(oldDropOpt)) {
                  const oldDrop = oldDropOpt.value;
                  const drops = yield* campaignStore.getDropsForCampaign(campaign.id);
                  const newDrop = drops.find((p) => p.id === oldDrop.id);
                  if (newDrop) {
                    if (oldDrop.currentMinutesWatched - newDrop.currentMinutesWatched >= 20) {
                      yield* Effect.logInfo(chalk`{red ${chan.login}} | {red Possible broken drops}`);
                      yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
                      yield* Ref.set(state.currentChannel, Option.none());
                      return;
                    }
                    yield* Ref.set(state.currentDrop, Option.some(newDrop));
                  }
                }
              }

              yield* Effect.sleep('1 minute');
            }),
            { until: () => Ref.get(state.currentChannel).pipe(Effect.map(Option.isNone)) },
          );

          yield* socket.unlisten(WsTopic.ChannelStream, channel.id).pipe(Effect.catchAllCause(() => Effect.void));
          yield* socket.unlisten(WsTopic.ChannelMoment, channel.id).pipe(Effect.catchAllCause(() => Effect.void));
          yield* socket.unlisten(WsTopic.ChannelUpdate, channel.id).pipe(Effect.catchAllCause(() => Effect.void));
          yield* Ref.set(state.minutesWatched, 0);
        }),
      { discard: true },
    );
    yield* Ref.set(state.currentChannel, Option.none());
  });

const performClaimDrops = (state: MainState, api: TwitchApi, campaignStore: CampaignStore, campaign: Campaign, drop: Drop) =>
  Effect.gen(function* () {
    yield* Ref.set(state.isClaiming, true);

    const totalAttempts = 5;
    let isClaimed = false;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (isClaimed) break;

      if (attempt > 0 || !drop.dropInstanceID) {
        yield* campaignStore.updateProgress;
        const drops = yield* campaignStore.getDropsForCampaign(campaign.id);
        const updatedDrop = drops.find((p) => p.id === drop.id);
        if (updatedDrop) {
          yield* Ref.set(state.currentDrop, Option.some(updatedDrop));
        }
      }

      const currentDropOpt = yield* Ref.get(state.currentDrop);
      if (Option.isNone(currentDropOpt)) break;

      const currentDrop = currentDropOpt.value;
      const claimRes = yield* api.claimDrops(currentDrop.dropInstanceID ?? '');

      if (claimRes.claimDropRewards) {
        yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Drops claimed}`);
        isClaimed = true;
        continue;
      }

      if (currentDrop.currentMinutesWatched < currentDrop.requiredMinutesWatched) {
        const isBroken = currentDrop.requiredMinutesWatched - currentDrop.currentMinutesWatched >= 20;
        yield* Effect.logInfo(chalk`{green ${drop.name}} | {red ${isBroken ? 'Possible broken drops' : 'Minutes not met'}}`);

        if (!isBroken) {
          yield* Ref.update(state.currentChannel, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
        }

        yield* Ref.set(state.currentChannel, Option.none());
        isClaimed = true;
        continue;
      }

      if (attempt < totalAttempts - 1) {
        if (attempt === 0) {
          yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found}`);
        }
        yield* Effect.logInfo(chalk`{yellow Waiting for ${attempt + 1}/${totalAttempts} minutes}`);
        yield* Effect.sleep('1 minute');
      }
    }

    if (!isClaimed) {
      yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Award not found after ${totalAttempts} minutes}`);
    }

    yield* Ref.set(state.isClaiming, false);
  });

export const MainWorkflow: Effect.Effect<
  void,
  never,
  CampaignStoreTag | TwitchApiTag | ConfigStoreTag | TwitchSocketTag | WatchServiceTag | Scope.Scope
> = Effect.gen(function* () {
  const campaignStore = yield* CampaignStoreTag;
  const api = yield* TwitchApiTag;
  const configStore = yield* ConfigStoreTag;
  const socket = yield* TwitchSocketTag;
  const watchService = yield* WatchServiceTag;

  const state: MainState = {
    currentCampaign: yield* Ref.make<Option.Option<Campaign>>(Option.none()),
    currentChannel: yield* Ref.make<Option.Option<Channel>>(Option.none()),
    currentDrop: yield* Ref.make<Option.Option<Drop>>(Option.none()),
    minutesWatched: yield* Ref.make(0),
    nextPointClaim: yield* Ref.make(0),
    nextWatch: yield* Ref.make(0),
    isClaiming: yield* Ref.make(false),
  };

  yield* api.init.pipe(Effect.orDie);
  const userId = yield* api.userId.pipe(Effect.orDie);

  yield* socket.listen(WsTopic.UserDrop, userId).pipe(Effect.orDie);
  yield* socket.listen(WsTopic.UserPoint, userId).pipe(Effect.orDie);

  yield* SocketWorkflow(state, configStore).pipe(Effect.orDie);

  const initializeCampaignState = () =>
    Effect.gen(function* () {
      const currentState = yield* Ref.get(campaignStore.state);
      if (currentState !== 'Initial') {
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

      yield* Ref.set(campaignStore.state, hasPriority ? 'PriorityOnly' : 'All');
      yield* Ref.set(state.isClaiming, false);
    });

  const mainLoop = () =>
    Effect.gen(function* () {
      yield* initializeCampaignState();

      const activeCampaigns = yield* campaignStore.getSortedActive;
      if (activeCampaigns.length === 0) {
        const currentState = yield* Ref.get(campaignStore.state);
        if (currentState === 'PriorityOnly') {
          yield* Ref.set(campaignStore.state, 'All');
          return;
        }
        yield* Ref.set(campaignStore.state, 'Initial');
        yield* Effect.logInfo(chalk`{yellow No active campaigns. Checking upcoming...}`);
        yield* Effect.sleep('10 minutes');
        return;
      }

      const campaign = activeCampaigns[0];
      yield* Ref.set(state.currentCampaign, Option.some(campaign));
      yield* campaignStore.updateProgress.pipe(Effect.orDie);

      const drops = yield* campaignStore.getDropsForCampaign(campaign.id).pipe(Effect.orDie);
      if (drops.length === 0) {
        yield* Effect.logInfo(chalk`${campaign.name} | {red No active drops}`);
        yield* campaignStore.setOffline(campaign.id, true);
        return;
      }

      if (getDropStatus(campaign.startAt, campaign.endAt).isExpired) {
        yield* Effect.logInfo(chalk`${campaign.name} | {red Campaigns expired}`);
        yield* campaignStore.updateCampaigns.pipe(Effect.orDie);
        return;
      }

      const drop = drops[0];
      yield* Ref.set(state.currentDrop, Option.some(drop));

      if (!drop.hasPreconditionsMet) {
        yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Preconditions drops}`);
        yield* campaignStore.setOffline(campaign.id, true);
        return;
      }

      if (drop.currentMinutesWatched >= drop.requiredMinutesWatched + 1) {
        if ((yield* configStore.get).isClaimDrops) {
          yield* performClaimDrops(state, api, campaignStore, campaign, drop).pipe(Effect.orDie);
        }
        return;
      }

      yield* performWatchLoop(state, api, socket, campaignStore, watchService, configStore).pipe(Effect.orDie);
      if ((yield* Ref.get(campaignStore.state)) === 'All') {
        yield* Ref.set(campaignStore.state, 'Initial');
      }
    });

  const updatePriorities = () =>
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

  const mainTaskLoop = () =>
    Effect.repeat(
      Effect.gen(function* () {
        yield* updatePriorities();
        yield* mainLoop();
        yield* Effect.sleep('10 seconds');
      }),
      Schedule.forever,
    ).pipe(Effect.asVoid);

  return yield* cycleWithRestart(
    Effect.all([mainTaskLoop(), UpcomingWorkflow(state), OfflineWorkflow(state, configStore), cycleMidnightRestart], {
      concurrency: 'unbounded',
    }),
  );
});
