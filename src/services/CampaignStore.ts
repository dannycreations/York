import { truncate } from '@vegapunk/utilities/common';
import { Array as ArrayEffect, Context, Effect, Layer, Option, Ref, Schema } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { ChannelDropsSchema, InventorySchema, ViewerDropsDashboardSchema, WsTopic } from '../core/Schemas';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper';
import { GqlQueries, TwitchApiTag } from './TwitchApi';
import { TwitchSocketTag } from './TwitchSocket';

import type { Campaign, Channel, Drop, Reward } from '../core/Schemas';
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

      const existingCampaigns = yield* Ref.get(campaignsRef);
      const newCampaigns = new Map<string, Campaign>();

      const processCampaign = (
        data: Schema.Schema.Type<typeof ViewerDropsDashboardSchema>['currentUser']['dropCampaigns'][number],
      ): Effect.Effect<void, TwitchApiError> =>
        Effect.gen(function* () {
          const gameName = data.game.displayName;
          if (config.exclusionList.has(gameName)) return;

          if (config.usePriorityConnected && data.self.isAccountConnected && !config.priorityList.has(gameName)) {
            yield* configStore.update((c) => ({
              ...c,
              priorityList: new Set([...c.priorityList, gameName]),
            }));
          }

          const latestConfig = yield* configStore.get;
          if (latestConfig.isPriorityOnly && !latestConfig.priorityList.has(gameName)) return;

          const existing = existingCampaigns.get(data.id);

          newCampaigns.set(data.id, {
            id: data.id,
            name: truncate((existing?.name || data.name).trim()),
            game: existing?.game || data.game,
            startAt: new Date(data.startAt),
            endAt: new Date(data.endAt),
            isAccountConnected: data.self.isAccountConnected,
            priority: existing?.priority ?? 0,
            isOffline: existing?.isOffline ?? false,
            allowChannels: existing?.allowChannels ?? [],
          });
        });

      yield* Effect.forEach(response.currentUser.dropCampaigns, processCampaign, { discard: true, concurrency: 10 });
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

      const mapDropData =
        (campaignId: string, total: number) =>
        (
          item: {
            data: Schema.Schema.Type<typeof InventorySchema>['currentUser']['inventory']['dropCampaignsInProgress'][number]['timeBasedDrops'][number];
            benefits: string[];
            startAt: Date;
            endAt: Date;
            isClaimed: boolean;
          },
          i: number,
        ): Drop => ({
          id: item.data.id,
          name: truncate(`${i + 1}/${total}, ${item.data.benefitEdges[0].benefit.name?.trim() ?? item.data.name.trim()}`),
          benefits: item.benefits,
          campaignId,
          startAt: item.startAt,
          endAt: item.endAt,
          requiredMinutesWatched: item.data.requiredMinutesWatched,
          requiredSubs: (item.data.requiredSubs ?? 0) > 0 ? item.data.requiredSubs! : undefined,
          isClaimed: item.isClaimed,
          hasPreconditionsMet: item.data.self?.hasPreconditionsMet ?? true,
          currentMinutesWatched: item.data.self?.currentMinutesWatched ?? 0,
          dropInstanceID: item.data.self?.dropInstanceID || undefined,
        });

      const filterDrops = (
        drops: Schema.Schema.Type<typeof InventorySchema>['currentUser']['inventory']['dropCampaignsInProgress'][number]['timeBasedDrops'],
      ) =>
        ArrayEffect.filterMap(drops, (data) => {
          const benefits = data.benefitEdges.map((e) => e.benefit.id);
          const startAt = new Date(data.startAt);
          const endAt = new Date(data.endAt);

          const isClaimed = (data.requiredSubs ?? 0) > 0 || (data.self?.isClaimed ?? false);
          const isWatched = data.self ? isMinutesWatchedMet({ ...data.self, requiredMinutesWatched: data.requiredMinutesWatched }) : false;

          const alreadyClaimed = benefits.some((id: string) => currentRewards.some((r) => r.id === id && r.lastAwardedAt >= startAt));
          if ((isWatched && !config.isClaimDrops) || alreadyClaimed || isClaimed) {
            return Option.none();
          }

          const minutesLeft = data.requiredMinutesWatched - (data.self?.currentMinutesWatched ?? 0);
          const status = getDropStatus(startAt, endAt, minutesLeft);
          if (status.isExpired || status.isUpcoming) {
            return Option.none();
          }

          return Option.some({ data, benefits, startAt, endAt, isClaimed });
        });

      const newProgress = ArrayEffect.flatMap(dropCampaignsInProgress, (campaign) => {
        const sortedDrops = [...campaign.timeBasedDrops].sort((a, b) => a.requiredMinutesWatched - b.requiredMinutesWatched);
        const filtered = filterDrops(sortedDrops);
        return filtered.map(mapDropData(campaign.id, filtered.length));
      });
      yield* Ref.set(progressRef, newProgress);
    });

    const getDropsForCampaign = (campaignId: string) =>
      Effect.gen(function* () {
        const detailRes = yield* api.campaignDetails(campaignId);
        const dropDetail = detailRes.user?.dropCampaign;
        if (!dropDetail) {
          yield* Ref.update(campaignsRef, (map) => {
            const next = new Map(map);
            next.delete(campaignId);
            return next;
          });
          return [];
        }

        yield* Ref.update(campaignsRef, (map) => {
          const next = new Map(map);
          const existing = next.get(campaignId);
          if (existing) {
            next.set(campaignId, {
              ...existing,
              name: truncate(dropDetail.name.trim()),
              game: dropDetail.game,
              allowChannels: dropDetail.allow?.channels?.map((c) => c.name) ?? [],
            });
          }
          return next;
        });

        if (!dropDetail.timeBasedDrops) return [];

        const currentRewards = yield* Ref.get(rewardsRef);
        const sortedDrops = [...dropDetail.timeBasedDrops].sort((a, b) => a.requiredMinutesWatched - b.requiredMinutesWatched);

        const config = yield* configStore.get;
        const filteredDrops = ArrayEffect.filterMap(sortedDrops, (data) => {
          const benefits = data.benefitEdges.map((e) => e.benefit.id);
          const startAt = new Date(data.startAt);
          const endAt = new Date(data.endAt);

          const isClaimed = (data.requiredSubs ?? 0) > 0 || (data.self?.isClaimed ?? false);
          const isWatched = data.self ? isMinutesWatchedMet({ ...data.self, requiredMinutesWatched: data.requiredMinutesWatched }) : false;

          const alreadyClaimed = benefits.some((id) => currentRewards.some((r) => r.id === id && r.lastAwardedAt >= startAt));
          if (alreadyClaimed || isClaimed) {
            return Option.none();
          }

          if (isWatched && !config.isClaimDrops) {
            return Option.none();
          }

          const minutesLeft = data.requiredMinutesWatched - (data.self?.currentMinutesWatched ?? 0);
          const status = getDropStatus(startAt, endAt, minutesLeft);
          if (status.isExpired || status.isUpcoming) {
            return Option.none();
          }

          return Option.some({ data, benefits, startAt, endAt, isClaimed });
        });

        return filteredDrops.map(
          ({ data, benefits, startAt, endAt, isClaimed }, i) =>
            ({
              id: data.id,
              name: truncate(`${i + 1}/${filteredDrops.length}, ${data.benefitEdges[0].benefit.name?.trim() ?? 'Unknown'}`),
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

      const activeCampaigns = ArrayEffect.fromIterable(map.values()).filter((c) => {
        if (c.isOffline) return false;
        const status = getDropStatus(c.startAt, c.endAt);
        if (status.isExpired) return false;
        if (state === 'PriorityOnly' && !config.priorityList.has(c.game.displayName)) return false;
        return true;
      });

      const dropCampaigns = [...activeCampaigns].sort((a, b) => a.endAt.getTime() - b.endAt.getTime());
      for (let i = 0; i < dropCampaigns.length; i++) {
        for (let j = i + 1; j < dropCampaigns.length; j++) {
          const left = dropCampaigns[i];
          const right = dropCampaigns[j];
          if (left.game.id !== right.game.id) continue;
          if (left.startAt <= right.startAt) continue;

          const campaign = dropCampaigns.splice(j, 1)[0];
          dropCampaigns.splice(i, 0, campaign);
        }
      }

      return dropCampaigns.sort((a, b) => b.priority - a.priority);
    });

    const getSortedUpcoming = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      return ArrayEffect.fromIterable(map.values())
        .filter((c) => getDropStatus(c.startAt, c.endAt).isUpcoming)
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
        const filterChannelsByCampaign = (channels: readonly Channel[], campaignId: string): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError> =>
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

        const cleanup = (channels: readonly Channel[]): Effect.Effect<void, TwitchSocketError> =>
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
          if (!response.game) return [];

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
