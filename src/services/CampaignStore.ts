import { truncate } from '@vegapunk/utilities/common';
import { Array as ArrayEffect, Context, Effect, Layer, Option, Ref } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { ChannelDropsSchema, getDropStatus, WsTopic } from '../core/Types';
import { GqlQueries, TwitchApiTag } from './TwitchApi';
import { TwitchSocketTag } from './TwitchSocket';

import type { Campaign, Channel, Drop, Reward } from '../core/Types';
import type { TwitchApiError } from './TwitchApi';
import type { TwitchSocketError } from './TwitchSocket';

const REWARD_EXPIRED_MS = 2_592_000_000;

export type CampaignStoreState = 'Initial' | 'PriorityOnly' | 'All';

export interface CampaignStore {
  readonly campaigns: Ref.Ref<ReadonlyMap<string, Campaign>>;
  readonly progress: Ref.Ref<ReadonlyArray<Drop>>;
  readonly rewards: Ref.Ref<ReadonlyArray<Reward>>;
  readonly updateCampaigns: Effect.Effect<void, TwitchApiError>;
  readonly updateProgress: Effect.Effect<void, TwitchApiError>;
  readonly getSortedActive: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getOffline: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly setOffline: (id: string, isOffline: boolean) => Effect.Effect<void>;
  readonly setPriority: (id: string, priority: number) => Effect.Effect<void>;
  readonly state: Ref.Ref<CampaignStoreState>;
  readonly getDropsForCampaign: (campaignId: string) => Effect.Effect<ReadonlyArray<Drop>, TwitchApiError>;
  readonly getChannelsForCampaign: (campaign: Campaign) => Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError>;
}

export class CampaignStoreTag extends Context.Tag('@services/CampaignStore')<CampaignStoreTag, CampaignStore>() {}

export const CampaignStoreLayer: Layer.Layer<CampaignStoreTag, never, TwitchApiTag | ConfigStoreTag | TwitchSocketTag> = Layer.effect(
  CampaignStoreTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const socket = yield* Effect.serviceOption(TwitchSocketTag).pipe(Effect.map(Option.getOrUndefined));
    const campaignsRef = yield* Ref.make<ReadonlyMap<string, Campaign>>(new Map());
    const progressRef = yield* Ref.make<ReadonlyArray<Drop>>([]);
    const rewardsRef = yield* Ref.make<ReadonlyArray<Reward>>([]);
    const stateRef = yield* Ref.make<CampaignStoreState>('Initial');

    const updateCampaigns = Effect.gen(function* () {
      const config = yield* configStore.get;
      const response = yield* api.dropsDashboard;

      const dropCampaigns = response.currentUser.dropCampaigns;
      const existingCampaigns = yield* Ref.get(campaignsRef);
      const newCampaigns = new Map<string, Campaign>();

      yield* Effect.forEach(
        dropCampaigns,
        (data) =>
          Effect.gen(function* () {
            const gameName = data.game.displayName;
            if (config.exclusionList.has(gameName)) {
              return;
            }

            if (config.usePriorityConnected && data.self.isAccountConnected) {
              if (!config.priorityList.has(gameName)) {
                yield* configStore.update((c) => ({
                  ...c,
                  priorityList: new Set([...c.priorityList, gameName]),
                }));
              }
            }

            const latestConfig = yield* configStore.get;
            if (latestConfig.isPriorityOnly && !latestConfig.priorityList.has(gameName)) {
              return;
            }

            const existing = existingCampaigns.get(data.id);
            let allowChannels: ReadonlyArray<string> = existing?.allowChannels ?? [];
            let campaignName = data.name;
            let game = data.game;

            if (allowChannels.length === 0) {
              const detailRes = yield* api.campaignDetails(data.id);
              const dropDetail = detailRes.user?.dropCampaign;
              if (dropDetail) {
                allowChannels = dropDetail.allow?.channels?.map((c) => c.name) ?? [];
                campaignName = dropDetail.name;
                game = dropDetail.game;
              }
            }

            const campaign: Campaign = {
              id: data.id,
              name: truncate(campaignName.trim()),
              game,
              startAt: new Date(data.startAt),
              endAt: new Date(data.endAt),
              isAccountConnected: data.self.isAccountConnected,
              priority: existing?.priority ?? 0,
              isOffline: existing?.isOffline ?? false,
              allowChannels,
            };

            newCampaigns.set(campaign.id, campaign);
          }),
        { discard: true },
      );
      yield* Ref.set(campaignsRef, newCampaigns);
    });

    const updateProgress = Effect.gen(function* () {
      const config = yield* configStore.get;
      const response = yield* api.inventory;

      const inventory = response.currentUser.inventory;
      const gameEventDrops = inventory.gameEventDrops;
      const dropCampaignsInProgress = inventory.dropCampaignsInProgress;

      const now = Date.now();
      const newRewards = gameEventDrops
        .map((d) => ({
          id: d.id,
          lastAwardedAt: new Date(d.lastAwardedAt),
        }))
        .filter((r) => now - r.lastAwardedAt.getTime() < REWARD_EXPIRED_MS);

      yield* Ref.set(rewardsRef, newRewards);

      const currentRewards = yield* Ref.get(rewardsRef);

      const newProgress = ArrayEffect.flatMap(dropCampaignsInProgress, (campaign) => {
        const sortedDrops = [...campaign.timeBasedDrops].sort((a, b) => a.requiredMinutesWatched - b.requiredMinutesWatched);

        const filteredDrops = ArrayEffect.filterMap(sortedDrops, (data) => {
          const benefits = data.benefitEdges.map((e) => e.benefit.id);
          const startAt = new Date(data.startAt);
          const endAt = new Date(data.endAt);

          const isClaimed = (data.requiredSubs ?? 0) > 0 || (data.self?.isClaimed ?? false);
          const isWatched = data.self ? data.self.currentMinutesWatched >= data.requiredMinutesWatched + 1 : false;

          const alreadyClaimed = benefits.some((id) => currentRewards.some((r) => r.id === id && r.lastAwardedAt >= startAt));
          if (isWatched && !config.isClaimDrops) {
            return Option.none();
          }
          if (alreadyClaimed || isClaimed) {
            return Option.none();
          }

          const status = getDropStatus(startAt, endAt);
          if (status.isExpired || status.isUpcoming) {
            return Option.none();
          }

          return Option.some({ data, benefits, startAt, endAt, isClaimed });
        });

        return filteredDrops.map(
          ({ data, benefits, startAt, endAt, isClaimed }, i) =>
            ({
              id: data.id,
              name: truncate(`${i + 1}/${filteredDrops.length}, ${data.benefitEdges[0].benefit.name?.trim() ?? data.name.trim()}`),
              benefits,
              campaignId: campaign.id,
              startAt,
              endAt,
              requiredMinutesWatched: data.requiredMinutesWatched,
              requiredSubs: data.requiredSubs || undefined,
              isClaimed,
              hasPreconditionsMet: data.self?.hasPreconditionsMet ?? true,
              currentMinutesWatched: data.self?.currentMinutesWatched ?? 0,
              dropInstanceID: data.self?.dropInstanceID || undefined,
            }) satisfies Drop,
        );
      });
      yield* Ref.set(progressRef, newProgress);
    });

    const getDropsForCampaign = (campaignId: string) =>
      Effect.gen(function* () {
        const detailRes = yield* api.campaignDetails(campaignId);
        const dropDetail = detailRes.user?.dropCampaign;
        if (!dropDetail) return [];

        const currentRewards = yield* Ref.get(rewardsRef);
        const sortedDrops = [...dropDetail.timeBasedDrops].sort((a, b) => a.requiredMinutesWatched - b.requiredMinutesWatched);

        const config = yield* configStore.get;
        const filteredDrops = ArrayEffect.filterMap(sortedDrops, (data) => {
          const benefits = data.benefitEdges.map((e) => e.benefit.id);
          const startAt = new Date(data.startAt);
          const endAt = new Date(data.endAt);

          const isClaimed = (data.requiredSubs ?? 0) > 0 || (data.self?.isClaimed ?? false);
          const isWatched = data.self ? data.self.currentMinutesWatched >= data.requiredMinutesWatched + 1 : false;

          const alreadyClaimed = benefits.some((id) => currentRewards.some((r) => r.id === id && r.lastAwardedAt >= startAt));
          if (alreadyClaimed || isClaimed) {
            return Option.none();
          }

          if (isWatched && !config.isClaimDrops) {
            return Option.none();
          }

          const status = getDropStatus(startAt, endAt);
          if (status.isExpired || status.isUpcoming) {
            return Option.none();
          }

          return Option.some({ data, benefits, startAt, endAt, isClaimed });
        });

        return filteredDrops.map(
          ({ data, benefits, startAt, endAt, isClaimed }, i) =>
            ({
              id: data.id,
              name: truncate(`${i + 1}/${filteredDrops.length}, ${data.benefitEdges[0].benefit.name.trim()}`),
              benefits,
              campaignId,
              startAt,
              endAt,
              requiredMinutesWatched: data.requiredMinutesWatched,
              requiredSubs: data.requiredSubs || undefined,
              isClaimed,
              hasPreconditionsMet: data.self?.hasPreconditionsMet ?? true,
              currentMinutesWatched: data.self?.currentMinutesWatched ?? 0,
              dropInstanceID: data.self?.dropInstanceID || undefined,
            }) satisfies Drop,
        );
      });

    const getSortedActive = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      const state = yield* Ref.get(stateRef);
      const config = yield* configStore.get;

      const dropCampaigns = ArrayEffect.fromIterable(map.values()).filter((c) => {
        if (c.isOffline) {
          return false;
        }
        if (getDropStatus(c.startAt, c.endAt).isExpired) {
          return false;
        }
        if (state === 'PriorityOnly' && !config.priorityList.has(c.game.displayName)) {
          return false;
        }
        return true;
      });

      const sorted = [...dropCampaigns].sort((a, b) => a.endAt.getTime() - b.endAt.getTime());
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const left = sorted[i];
          const right = sorted[j];
          if (left.game.id !== right.game.id) {
            continue;
          }
          if (left.startAt.getTime() <= right.startAt.getTime()) {
            continue;
          }

          const campaign = sorted.splice(j, 1)[0];
          sorted.splice(i, 0, campaign);
        }
      }
      return sorted;
    });

    const getSortedUpcoming = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      return ArrayEffect.fromIterable(map.values())
        .filter((c) => c.startAt > new Date())
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    });

    const getOffline = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      return ArrayEffect.fromIterable(map.values()).filter((c) => c.isOffline);
    });

    const setOffline = (id: string, isOffline: boolean) =>
      Ref.update(campaignsRef, (map) => {
        const next = new Map(map);
        const campaign = next.get(id);
        if (campaign) {
          next.set(id, { ...campaign, isOffline });
        }
        return next;
      });

    const setPriority = (id: string, priority: number) =>
      Ref.update(campaignsRef, (map) => {
        const next = new Map(map);
        const campaign = next.get(id);
        if (campaign) {
          next.set(id, { ...campaign, priority });
        }
        return next;
      });

    const getChannelsForCampaign = (campaign: Campaign) =>
      Effect.gen(function* () {
        const filterChannelsByCampaign = (channels: readonly Channel[], campaignId: string) =>
          Effect.gen(function* () {
            if (channels.length === 0) {
              return [];
            }
            const responses = yield* api.graphql(
              channels.map((c) => GqlQueries.channelDrops(c.id)),
              ChannelDropsSchema,
            );
            return channels.filter((_, i) => {
              const campaigns = responses[i].channel.viewerDropCampaigns;
              return campaigns?.some((vc) => vc.id === campaignId) ?? false;
            });
          });

        const cleanup = (channels: readonly Channel[]) =>
          Effect.gen(function* () {
            if (!socket) {
              return;
            }
            yield* Effect.forEach(
              channels,
              (c) =>
                Effect.all([
                  socket.unlisten(WsTopic.ChannelStream, c.id),
                  socket.unlisten(WsTopic.ChannelMoment, c.id),
                  socket.unlisten(WsTopic.ChannelUpdate, c.id),
                ]),
              { discard: true },
            );
          });

        if (campaign.allowChannels.length > 0) {
          const response = yield* api.channelStreams(campaign.allowChannels.slice(0, 30));
          const users = response.users;
          const onlineChannels = ArrayEffect.filterMap(users, (user) => {
            if (!user.stream) {
              return Option.none();
            }
            return Option.some({
              id: user.id,
              login: user.login,
              gameId: campaign.game.id,
              isOnline: true,
            } satisfies Channel);
          });
          const filtered = yield* filterChannelsByCampaign(onlineChannels, campaign.id);
          yield* cleanup(onlineChannels.filter((oc) => !filtered.some((f) => f.id === oc.id)));
          return filtered;
        } else {
          const response = yield* api.gameDirectory(campaign.game.slug || '');
          const edges = response.game.streams.edges;
          const onlineChannels = ArrayEffect.filterMap(edges, (edge) => {
            if (!edge.node.broadcaster) {
              return Option.none();
            }
            return Option.some({
              id: edge.node.broadcaster.id,
              login: edge.node.broadcaster.login,
              gameId: campaign.game.id,
              isOnline: true,
            } satisfies Channel);
          });
          const filtered = yield* filterChannelsByCampaign(onlineChannels, campaign.id);
          yield* cleanup(onlineChannels.filter((oc) => !filtered.some((f) => f.id === oc.id)));
          return filtered;
        }
      });

    return {
      campaigns: campaignsRef,
      progress: progressRef,
      rewards: rewardsRef,
      updateCampaigns,
      updateProgress,
      getSortedActive,
      getSortedUpcoming,
      getOffline,
      setOffline,
      setPriority,
      state: stateRef,
      getDropsForCampaign,
      getChannelsForCampaign,
    };
  }),
);
