import { chalk } from '@vegapunk/utilities';
import { Array, Effect, Option, Ref, Schedule, Stream } from 'effect';

import { ConfigStore } from '../core/Config';
import { Campaign, Channel, Drop } from '../core/Types';
import { CampaignStoreTag } from '../services/CampaignStore';
import { GqlQueries, TwitchApiTag } from '../services/TwitchApi';
import { TwitchSocketTag } from '../services/TwitchSocket';
import { WatchServiceTag } from '../services/WatchService';
import { cycleMidnightRestart, cycleWithRestart } from '../structures/RuntimeClient';

export const MainWorkflow = Effect.gen(function* () {
  const campaignStore = yield* CampaignStoreTag;
  const api = yield* TwitchApiTag;
  const socket = yield* TwitchSocketTag;
  const configStore = yield* ConfigStore;
  const watchService = yield* WatchServiceTag;

  const currentCampaignRef = yield* Ref.make<Option.Option<Campaign>>(Option.none());
  const currentChannelRef = yield* Ref.make<Option.Option<Channel>>(Option.none());
  const currentDropRef = yield* Ref.make<Option.Option<Drop>>(Option.none());

  const minutesWatchedRef = yield* Ref.make(0);
  const nextPointClaimRef = yield* Ref.make(0);

  yield* Effect.logInfo(chalk`{bold.cyan York starting...}`);
  yield* api.init;

  // Socket Processor (Parity with Listeners)
  const socketProcessor = socket.messages.pipe(
    Stream.runForEach((msg) =>
      Effect.gen(function* () {
        const currentCampaign = yield* Ref.get(currentCampaignRef);
        const currentChannel = yield* Ref.get(currentChannelRef);
        const currentDrop = yield* Ref.get(currentDropRef);

        if (Option.isNone(currentCampaign) || Option.isNone(currentChannel)) return;

        const channel = currentChannel.value;

        if (msg.topicId !== channel.id && msg.topicId !== (yield* api.userId)) return;

        switch (msg.topicType) {
          case 'video-playback-by-id':
            if (msg.type === 'stream-down') {
              yield* Ref.update(currentChannelRef, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
              yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Stream down}`);
            }
            break;
          case 'community-points-user-v1':
            if (msg.type === 'claim-available') {
              const claimID = msg.data.claim.id;
              yield* api.graphql(GqlQueries.claimPoints(channel.id, claimID));
              yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed!}`);
            } else if (msg.type === 'points-earned') {
              // Parity with UserPointListener.ts:51
              const now = Date.now();
              const nextClaim = yield* Ref.get(nextPointClaimRef);
              if (now >= nextClaim) {
                yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points earned, checking for available claims...}`);
                const channelData = yield* api.channelPoints(channel.login);
                const availableClaim = channelData.data.community.channel.self.communityPoints.availableClaim;
                if (availableClaim) {
                  yield* api.graphql(GqlQueries.claimPoints(channel.id, availableClaim.id));
                  yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed!}`);
                  yield* Ref.set(nextPointClaimRef, Date.now() + 900_000);
                }
              }
            }
            break;
          case 'community-moments-channel-v1':
            if (msg.type === 'active') {
              yield* api.graphql(GqlQueries.claimMoments(msg.data.moment_id));
              yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Moment claimed!}`);
            }
            break;
          case 'broadcast-settings-update':
            if (msg.channel_id === channel.id && channel.gameId) {
              if (String(msg.game_id) !== channel.gameId) {
                yield* Ref.update(currentChannelRef, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
                yield* Effect.logInfo(chalk`{red ${channel.login}} | {red Game changed to ${msg.game}}`);
              }
            }
            break;
          case 'user-drop-events':
            if (msg.type === 'drop-progress' && Option.isSome(currentDrop)) {
              const drop = currentDrop.value;
              if (msg.data.drop_id === drop.id) {
                const desync = msg.data.current_progress_min - drop.currentMinutesWatched;
                if (desync !== 0) {
                  yield* Ref.update(currentDropRef, (d) => Option.map(d, (dr) => ({ ...dr, currentMinutesWatched: msg.data.current_progress_min })));
                  yield* Ref.set(minutesWatchedRef, 1);
                  yield* Effect.logInfo(chalk`{green ${drop.name}} | {yellow Desync ${desync > 0 ? '+' : ''}${desync} minutes}`);
                }
              }
            } else if (msg.type === 'drop-claim' && Option.isSome(currentDrop)) {
              const drop = currentDrop.value;
              if (msg.data.drop_id === drop.id) {
                yield* Ref.update(currentDropRef, (d) => Option.map(d, (dr) => ({ ...dr, dropInstanceID: msg.data.drop_instance_id })));
              }
            }
            break;
        }
      }),
    ),
    Effect.fork,
  );

  const getChannelsForCampaign = (campaign: Campaign) =>
    Effect.gen(function* () {
      if (campaign.allowChannels.length > 0) {
        const response = yield* api.graphql<any>(GqlQueries.channelStreams(campaign.allowChannels.slice(0, 30)));
        const users = response[0].data.users;
        const onlineChannels = Array.filterMap(users, (user: any) => {
          if (!user?.stream) return Option.none();
          return Option.some({
            id: user.id,
            login: user.login,
            gameId: campaign.game.id,
            isOnline: true,
          } as Channel);
        });
        return yield* filterChannelsByCampaign(onlineChannels, campaign.id);
      } else {
        const response = yield* api.graphql<any>(GqlQueries.gameDirectory(campaign.game.slug || ''));
        const edges = response[0].data.game.streams.edges;
        const onlineChannels = Array.filterMap(edges, (edge: any) => {
          if (!edge.node.broadcaster) return Option.none();
          return Option.some({
            id: edge.node.broadcaster.id,
            login: edge.node.broadcaster.login,
            gameId: campaign.game.id,
            isOnline: true,
          } as Channel);
        });
        return yield* filterChannelsByCampaign(onlineChannels, campaign.id);
      }
    });

  const filterChannelsByCampaign = (channels: Channel[], campaignId: string) =>
    Effect.gen(function* () {
      if (channels.length === 0) return [];
      const responses = yield* api.graphql<any>(channels.map((c) => GqlQueries.channelDrops(c.id)));
      return channels.filter((_, i) => {
        const viewerCampaigns = responses[i].data.channel.viewerDropCampaigns;
        return viewerCampaigns?.some((vc: any) => vc.id === campaignId);
      });
    });

  const watchLoop = Effect.gen(function* () {
    const campaignOpt = yield* Ref.get(currentCampaignRef);
    if (Option.isNone(campaignOpt)) return;
    const campaign = campaignOpt.value;

    const channels = yield* getChannelsForCampaign(campaign);
    if (channels.length === 0) {
      yield* Effect.logInfo(chalk`{red ${campaign.name}} | {red No online channels}`);
      yield* Ref.update(campaignStore.campaigns, (map) => {
        const next = new Map(map);
        next.set(campaign.id, { ...campaign, isOffline: true });
        return next;
      });
      return;
    }

    const userId = yield* api.userId;

    for (const channel of channels) {
      yield* Ref.set(currentChannelRef, Option.some(channel));
      yield* socket.listen('video-playback-by-id', channel.id);
      yield* socket.listen('community-moments-channel-v1', channel.id);
      yield* socket.listen('broadcast-settings-update', channel.id);
      yield* socket.listen('community-points-user-v1', userId);
      yield* socket.listen('user-drop-events', userId);

      // Initial claim for points/moments (parity with DropMain.ts:158)
      const channelData = yield* api.channelPoints(channel.login);
      const availableClaim = channelData.data.community.channel.self.communityPoints.availableClaim;
      if (availableClaim && (yield* configStore.get).isClaimPoints) {
        yield* api.graphql(GqlQueries.claimPoints(channel.id, availableClaim.id));
        yield* Effect.logInfo(chalk`{green ${channel.login}} | {yellow Points claimed!}`);
      }

      while (true) {
        const chanOpt = yield* Ref.get(currentChannelRef);
        if (Option.isNone(chanOpt) || !chanOpt.value.isOnline) break;
        let chan = chanOpt.value;

        if (!chan.currentSid) {
          const streamRes = yield* api.request<any>({
            url: 'https://api.twitch.tv/helix/streams',
            headers: { 'client-id': 'uaw3vx1k0ttq74u9b2zfvt768eebh1' },
            searchParams: { user_id: chan.id },
            responseType: 'json',
          });
          if (streamRes.body.data && streamRes.body.data.length > 0) {
            const live = streamRes.body.data[0];
            chan = {
              ...chan,
              currentSid: live.id,
              currentGameId: live.game_id,
              currentGameName: live.game_name,
            };
            yield* Ref.set(currentChannelRef, Option.some(chan));
          } else {
            yield* Ref.update(currentChannelRef, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
            break;
          }
        }

        if (chan.gameId && chan.currentGameId && chan.gameId !== chan.currentGameId) {
          yield* Effect.logInfo(chalk`{red ${chan.login}} | {red Playing different game: ${chan.currentGameName}}`);
          yield* Ref.update(currentChannelRef, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
          break;
        }

        const { success, hlsUrl } = yield* watchService.watch(chan);
        if (hlsUrl !== chan.hlsUrl) {
          yield* Ref.update(currentChannelRef, (c) => Option.map(c, (ch) => ({ ...ch, hlsUrl })));
        }

        if (success) {
          yield* Ref.update(minutesWatchedRef, (m) => m + 1);
          const dropOpt = yield* Ref.get(currentDropRef);
          if (Option.isSome(dropOpt)) {
            const drop = dropOpt.value;
            yield* Effect.logInfo(
              chalk`{green ${drop.name}} | {green ${chan.login}} | {green ${drop.currentMinutesWatched + 1}/${drop.requiredMinutesWatched}}`,
            );
            yield* Ref.update(currentDropRef, (d) => Option.map(d, (dr) => ({ ...dr, currentMinutesWatched: dr.currentMinutesWatched + 1 })));
          }
        } else {
          // Parity with DropMain.ts:116 - if watch fails, dequeue channel
          yield* Effect.logInfo(chalk`{red ${chan.login}} | {red Watch failed, switching channel...}`);
          const dropOpt = yield* Ref.get(currentDropRef);
          if (Option.isSome(dropOpt)) {
            const drop = dropOpt.value;
            if (drop.requiredMinutesWatched - drop.currentMinutesWatched >= 20) {
              yield* Effect.logInfo(chalk`{green ${drop.name}} | {red Possible broken drops, switching campaign...}`);
              yield* Ref.update(currentChannelRef, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
              yield* Ref.set(currentCampaignRef, Option.none());
              break;
            }
          }
          yield* Ref.update(currentChannelRef, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
          break;
        }

        const mins = yield* Ref.get(minutesWatchedRef);
        if (mins >= 20) {
          yield* Ref.set(minutesWatchedRef, 0);
          const oldDropOpt = yield* Ref.get(currentDropRef);
          yield* campaignStore.updateProgress;
          yield* campaignStore.updateCampaigns;

          if (Option.isSome(oldDropOpt)) {
            const oldDrop = oldDropOpt.value;
            const progress = yield* Ref.get(campaignStore.progress);
            const newDrop = progress.find((p) => p.id === oldDrop.id);
            if (newDrop) {
              // Parity with Campaign.ts:88 - detect broken drops during 20min sync
              if (oldDrop.currentMinutesWatched - newDrop.currentMinutesWatched >= 20) {
                yield* Effect.logInfo(chalk`{red ${chan.login}} | {red Possible broken drops detected during sync, switching channel...}`);
                yield* Ref.update(currentChannelRef, (c) => Option.map(c, (ch) => ({ ...ch, isOnline: false })));
                break;
              }
              yield* Ref.set(currentDropRef, Option.some(newDrop));
            }
          }
        }

        yield* Effect.sleep('1 minute');
      }

      yield* socket.unlisten('video-playback-by-id', channel.id);
      yield* socket.unlisten('community-moments-channel-v1', channel.id);
      yield* socket.unlisten('broadcast-settings-update', channel.id);
    }
  });

  const midnightRestartTask = Effect.gen(function* () {
    yield* cycleMidnightRestart;
    yield* Effect.logInfo(chalk`{bold.yellow It's midnight time. Restarting app...}`);
    // RuntimeClient handles the actual restart via RuntimeRestart error
  });

  const mainLoop = Effect.gen(function* () {
    yield* campaignStore.updateCampaigns;
    yield* campaignStore.updateProgress;

    const activeCampaigns = yield* campaignStore.getSortedActive;
    if (activeCampaigns.length === 0) {
      yield* Effect.logInfo(chalk`{yellow No active campaigns. Checking upcoming...}`);
      yield* Effect.sleep('10 minutes');
      return;
    }

    for (const campaign of activeCampaigns) {
      yield* Ref.set(currentCampaignRef, Option.some(campaign));
      const drops = (yield* Ref.get(campaignStore.progress)).filter((d) => d.campaignId === campaign.id && !d.isClaimed);
      if (drops.length === 0) continue;

      for (const drop of drops) {
        yield* Ref.set(currentDropRef, Option.some(drop));
        yield* watchLoop;

        const updatedDropOpt = yield* Ref.get(currentDropRef);
        if (Option.isSome(updatedDropOpt)) {
          const updatedDrop = updatedDropOpt.value;
          if (updatedDrop.currentMinutesWatched >= updatedDrop.requiredMinutesWatched) {
            // Claim logic with parity to DropMain.ts:91 (Retry/Wait)
            if ((yield* configStore.get).isClaimDrops) {
              let claimed = false;
              for (let i = 0; i < 5; i++) {
                if (!updatedDrop.dropInstanceID) {
                  yield* campaignStore.updateProgress;
                  const progress = yield* Ref.get(campaignStore.progress);
                  const d = progress.find((p) => p.id === updatedDrop.id);
                  if (d?.dropInstanceID) {
                    yield* Ref.update(currentDropRef, (opt) => Option.map(opt, (dr) => ({ ...dr, dropInstanceID: d.dropInstanceID })));
                  }
                }

                const currentD = (yield* Ref.get(currentDropRef)).pipe(Option.getOrUndefined);
                if (currentD?.dropInstanceID) {
                  const res = yield* api.graphql<any>(GqlQueries.claimDrops(currentD.dropInstanceID));
                  if (res[0].data.claimDropRewards) {
                    yield* Effect.logInfo(chalk`{green ${updatedDrop.name}} | {yellow Claimed!}`);
                    claimed = true;
                    break;
                  }
                }

                if (i < 4) {
                  yield* Effect.logInfo(chalk`{green ${updatedDrop.name}} | {yellow Waiting for ${i + 1}/5 minutes for award...}`);
                  yield* Effect.sleep('1 minute');
                }
              }
              if (!claimed) {
                yield* Effect.logInfo(chalk`{green ${updatedDrop.name}} | {red Award not found after 5 minutes}`);
              }
            }
          }
        }
      }
    }
  });

  yield* socketProcessor;

  const upcomingTask = Effect.gen(function* () {
    while (true) {
      yield* campaignStore.updateCampaigns;
      const upcoming = yield* campaignStore.getSortedUpcoming;
      if (upcoming.length > 0) {
        const next = upcoming[0];
        const waitMs = next.startAt.getTime() - Date.now();
        if (waitMs > 0) {
          yield* Effect.logInfo(chalk`{bold.yellow Next upcoming campaign: ${next.name} in ${Math.floor(waitMs / 60000)} minutes}`);
          yield* Effect.sleep(`${waitMs} millis`);
        }
      } else {
        yield* Effect.sleep('2 hours');
      }
    }
  });

  const offlineTask = Effect.gen(function* () {
    while (true) {
      const campaignsMap = yield* Ref.get(campaignStore.campaigns);
      const offline = Array.fromIterable(campaignsMap.values()).filter((c) => c.isOffline);
      for (const campaign of offline) {
        const channels = yield* getChannelsForCampaign(campaign);
        if (channels.length > 0) {
          yield* Effect.logInfo(chalk`{bold.yellow ${campaign.name}} | {bold.yellow {strikethrough Offline}}`);
          yield* Ref.update(campaignStore.campaigns, (map) => {
            const next = new Map(map);
            next.set(campaign.id, { ...campaign, isOffline: false });
            return next;
          });
        }
      }
      yield* Effect.sleep('2 minutes');
    }
  });

  // Priority logic from DropMain.ts:184
  const updatePriorities = Effect.gen(function* () {
    const config = yield* configStore.get;
    yield* Ref.update(campaignStore.campaigns, (map) => {
      const next = new Map(map);
      for (const [id, campaign] of next) {
        const isPriority = config.priorityList.has(campaign.game.displayName);
        next.set(id, { ...campaign, priority: isPriority ? 1 : 0 });
      }
      return next;
    });
  });

  return yield* cycleWithRestart(
    Effect.all([Effect.repeat(Effect.zipRight(updatePriorities, mainLoop), Schedule.forever), upcomingTask, offlineTask, midnightRestartTask], {
      concurrency: 'unbounded',
    }),
  );
});
