import { truncate } from '@vegapunk/utilities/common';
import { Array, Context, Effect, Layer, Option, Order, Ref, Schema } from 'effect';

import { ConfigStoreTag } from '../core/Config';
import { ChannelDropsSchema, RewardExpiredMs, ViewerDropsDashboardSchema, WsTopic } from '../core/Schemas';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper';
import { GqlQueries, TwitchApiTag } from './TwitchApi';
import { TwitchSocketTag } from './TwitchSocket';

import type { ClientConfig } from '../core/Config';
import type { Campaign, Channel, Drop, Reward } from '../core/Schemas';
import type { StoreClient } from '../structures/StoreClient';
import type { TwitchApi, TwitchApiError } from './TwitchApi';
import type { TwitchSocket, TwitchSocketError } from './TwitchSocket';

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
  readonly addRewards: (rewards: ReadonlyArray<Reward>) => Effect.Effect<void>;
}

export class CampaignStoreTag extends Context.Tag('@services/CampaignStore')<CampaignStoreTag, CampaignStore>() {}

const filterChannelsByCampaign = (
  api: TwitchApi,
  channels: readonly Channel[],
  campaignId: string,
): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError> =>
  channels.length === 0
    ? Effect.succeed([])
    : api
        .graphql(
          channels.map((c) => GqlQueries.channelDrops(c.id)),
          ChannelDropsSchema,
        )
        .pipe(
          Effect.map((responses) => channels.filter((_, i) => responses[i].channel.viewerDropCampaigns?.some((vc) => vc.id === campaignId) ?? false)),
        );

const cleanupSocketListeners = (socket: TwitchSocket | undefined, channels: readonly Channel[]): Effect.Effect<void, TwitchSocketError> =>
  !socket || channels.length === 0
    ? Effect.void
    : Effect.forEach(
        channels,
        (c) =>
          Effect.all([
            socket.unlisten(WsTopic.ChannelStream, c.id),
            socket.unlisten(WsTopic.ChannelMoment, c.id),
            socket.unlisten(WsTopic.ChannelUpdate, c.id),
          ]),
        { discard: true },
      );

const processCampaignData = (
  data: Schema.Schema.Type<typeof ViewerDropsDashboardSchema>['currentUser']['dropCampaigns'][number],
  existingCampaigns: ReadonlyMap<string, Campaign>,
  configStore: StoreClient<ClientConfig>,
) =>
  Effect.gen(function* () {
    const config = yield* configStore.get;
    const gameName = data.game.displayName;
    if (config.exclusionList.has(gameName)) return Option.none();

    if (config.usePriorityConnected && data.self.isAccountConnected && !config.priorityList.has(gameName)) {
      yield* configStore.update((c) => ({
        ...c,
        priorityList: new Set([...c.priorityList, gameName]),
      }));
    }

    const latestConfig = yield* configStore.get;
    if (latestConfig.isPriorityOnly && !latestConfig.priorityList.has(gameName)) return Option.none();

    const existing = existingCampaigns.get(data.id);

    return Option.some({
      id: data.id,
      name: truncate((existing?.name || data.name).trim()),
      game: existing?.game || data.game,
      startAt: data.startAt,
      endAt: data.endAt,
      isAccountConnected: data.self.isAccountConnected,
      priority: existing?.priority ?? 0,
      isOffline: existing?.isOffline ?? false,
      allowChannels: existing?.allowChannels ?? [],
    } satisfies Campaign);
  });

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

    const updateCampaigns: Effect.Effect<void, TwitchApiError> = Effect.gen(function* () {
      const response = yield* api.dropsDashboard;
      const existingCampaigns = yield* Ref.get(campaignsRef);
      const newCampaigns = new Map<string, Campaign>();

      yield* Effect.forEach(
        response.currentUser.dropCampaigns,
        (data) =>
          Effect.gen(function* () {
            const campaign = yield* processCampaignData(data, existingCampaigns, configStore);
            if (Option.isSome(campaign)) {
              newCampaigns.set(campaign.value.id, campaign.value);
            }
          }),
        { discard: true, concurrency: 10 },
      );
      yield* Ref.set(campaignsRef, newCampaigns);
    });

    const updateProgress: Effect.Effect<void, TwitchApiError> = Effect.gen(function* () {
      const config = yield* configStore.get;
      const response = yield* api.inventory;

      const inventory = response.currentUser.inventory;
      const gameEventDrops = inventory.gameEventDrops;
      const dropCampaignsInProgress = inventory.dropCampaignsInProgress;

      const now = Date.now();
      const newRewards = gameEventDrops
        .map((d) => ({
          id: d.id,
          lastAwardedAt: d.lastAwardedAt,
        }))
        .filter((r) => now - r.lastAwardedAt.getTime() < RewardExpiredMs);

      yield* Ref.set(rewardsRef, newRewards);

      const currentRewards = yield* Ref.get(rewardsRef);

      const newProgress = Array.flatMap(dropCampaignsInProgress, (campaign) => {
        const sortedDrops = Array.sort(
          campaign.timeBasedDrops,
          Order.mapInput(Order.number, (d: { readonly requiredMinutesWatched: number }) => d.requiredMinutesWatched),
        );
        const filtered = Array.filterMap(sortedDrops, (data) => {
          const benefits = data.benefitEdges.map((e) => e.benefit.id);
          const { startAt, endAt, requiredMinutesWatched } = data;

          const isClaimed = (data.requiredSubs ?? 0) > 0 || (data.self?.isClaimed ?? false);
          const isWatched = data.self ? isMinutesWatchedMet({ ...data.self, requiredMinutesWatched }) : false;

          const alreadyClaimed = benefits.some((id) => currentRewards.some((r) => r.id === id && r.lastAwardedAt >= startAt));
          if ((isWatched && !config.isClaimDrops) || alreadyClaimed || isClaimed) {
            return Option.none();
          }

          const minutesLeft = requiredMinutesWatched - (data.self?.currentMinutesWatched ?? 0);
          const status = getDropStatus(startAt, endAt, minutesLeft);
          const hasAward = !!data.self?.dropInstanceID;

          if (status.isExpired || (status.isUpcoming && !hasAward)) {
            return Option.none();
          }

          return Option.some({
            id: data.id,
            name: truncate(data.benefitEdges[0].benefit.name?.trim() ?? data.name.trim()),
            benefits,
            campaignId: campaign.id,
            startAt,
            endAt,
            requiredMinutesWatched,
            requiredSubs: (data.requiredSubs ?? 0) > 0 ? data.requiredSubs! : undefined,
            isClaimed,
            hasPreconditionsMet: data.self?.hasPreconditionsMet ?? true,
            currentMinutesWatched: data.self?.currentMinutesWatched ?? 0,
            dropInstanceID: data.self?.dropInstanceID || undefined,
          } satisfies Drop);
        });

        return filtered.map((drop, i) => ({
          ...drop,
          name: truncate(`${i + 1}/${filtered.length}, ${drop.name}`),
        }));
      });

      yield* Ref.update(progressRef, (current) => {
        return Array.reduce(newProgress, [...current], (acc, drop) => {
          const index = acc.findIndex((d) => d.id === drop.id);
          if (index !== -1) {
            acc[index] = drop;
          } else {
            acc.push(drop);
          }
          return acc;
        });
      });
    });

    const getDropsForCampaign = (campaignId: string): Effect.Effect<ReadonlyArray<Drop>, TwitchApiError> =>
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
        const sortedDrops = Array.sort(
          dropDetail.timeBasedDrops,
          Order.mapInput(Order.number, (d: { readonly requiredMinutesWatched: number }) => d.requiredMinutesWatched),
        );

        const config = yield* configStore.get;
        const activeDrops = Array.filterMap(sortedDrops, (data) => {
          const benefits = data.benefitEdges.map((e) => e.benefit.id);
          const startAt = data.startAt;
          const endAt = data.endAt;

          const isClaimed = (data.requiredSubs ?? 0) > 0 || (data.self?.isClaimed ?? false);
          const isWatched = data.self ? isMinutesWatchedMet({ ...data.self, requiredMinutesWatched: data.requiredMinutesWatched }) : false;

          const alreadyClaimed = benefits.some((id) => currentRewards.some((r) => r.id === id && r.lastAwardedAt >= startAt));
          if (alreadyClaimed || isClaimed) return Option.none();
          if (isWatched && !config.isClaimDrops) return Option.none();

          const minutesLeft = data.requiredMinutesWatched - (data.self?.currentMinutesWatched ?? 0);
          const status = getDropStatus(startAt, endAt, minutesLeft);
          if (status.isExpired || status.isUpcoming) return Option.none();

          return Option.some({
            id: data.id,
            name: truncate(data.benefitEdges[0].benefit.name?.trim() ?? data.name.trim()),
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
          } satisfies Drop);
        });

        const result = activeDrops.map((drop, i) => ({
          ...drop,
          name: truncate(`${i + 1}/${activeDrops.length}, ${drop.name}`),
        }));

        yield* Ref.update(progressRef, (current) =>
          Array.reduce(result, [...current], (acc, drop) => {
            const index = acc.findIndex((d) => d.id === drop.id);
            if (index !== -1) {
              acc[index] = drop;
            } else {
              acc.push(drop);
            }
            return acc;
          }),
        );

        return result;
      });

    const getSortedActive: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      const state = yield* Ref.get(stateRef);
      const config = yield* configStore.get;

      const activeCampaigns = Array.fromIterable(map.values()).filter((c) => {
        if (c.isOffline) return false;
        const status = getDropStatus(c.startAt, c.endAt);
        if (status.isExpired) return false;
        if (state === 'PriorityOnly' && !config.priorityList.has(c.game.displayName)) return false;
        return true;
      });

      const sortedByEndAt = Array.sort(
        activeCampaigns,
        Order.mapInput(Order.number, (c: Campaign) => c.endAt.getTime()),
      );

      const dropCampaigns = Array.reduce(Array.range(0, sortedByEndAt.length - 1), [...sortedByEndAt], (acc, i) => {
        return Array.reduce(Array.range(i + 1, acc.length - 1), acc, (innerAcc, j) => {
          const left = innerAcc[i];
          const right = innerAcc[j];
          if (left.game.id === right.game.id && left.startAt > right.startAt) {
            const next = [...innerAcc];
            const [campaign] = next.splice(j, 1);
            next.splice(i, 0, campaign);
            return next;
          }
          return innerAcc;
        });
      });

      return Array.sort(dropCampaigns, Order.reverse(Order.mapInput(Order.number, (c: Campaign) => c.priority)));
    });

    const getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      return Array.fromIterable(map.values())
        .filter((c) => getDropStatus(c.startAt, c.endAt).isUpcoming)
        .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    });

    const getOffline: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const map = yield* Ref.get(campaignsRef);
      return Array.fromIterable(map.values()).filter((c) => c.isOffline);
    });

    const setOffline = (id: string, isOffline: boolean): Effect.Effect<void> =>
      Ref.update(campaignsRef, (map) => {
        const next = new Map(map);
        const campaign = next.get(id);
        if (campaign) {
          next.set(id, { ...campaign, isOffline });
        }
        return next;
      });

    const setPriority = (id: string, priority: number): Effect.Effect<void> =>
      Ref.update(campaignsRef, (map) => {
        const next = new Map(map);
        const campaign = next.get(id);
        if (campaign) {
          next.set(id, { ...campaign, priority });
        }
        return next;
      });

    const getChannelsForCampaign = (campaign: Campaign): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError> =>
      Effect.gen(function* () {
        if (campaign.allowChannels.length > 0) {
          const response = yield* api.channelStreams(campaign.allowChannels.slice(0, 30));
          const users = response.users;
          const onlineChannels = Array.filterMap(users, (user) => {
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
          const filtered = yield* filterChannelsByCampaign(api, onlineChannels, campaign.id);
          yield* cleanupSocketListeners(
            socket,
            onlineChannels.filter((oc) => !filtered.some((f) => f.id === oc.id)),
          );
          return filtered;
        } else {
          const response = yield* api.gameDirectory(campaign.game.slug || '');
          if (!response.game) return [];

          const edges = response.game.streams.edges;
          const onlineChannels = Array.filterMap(edges, (edge) => {
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
          const filtered = yield* filterChannelsByCampaign(api, onlineChannels, campaign.id);
          yield* cleanupSocketListeners(
            socket,
            onlineChannels.filter((oc) => !filtered.some((f) => f.id === oc.id)),
          );
          return filtered;
        }
      });

    const addRewards = (rewards: ReadonlyArray<Reward>): Effect.Effect<void> =>
      Ref.update(rewardsRef, (current) =>
        Array.reduce(rewards, [...current], (acc, reward) => {
          const index = acc.findIndex((r) => r.id === reward.id);
          if (index !== -1) {
            acc[index] = reward;
          } else {
            acc.push(reward);
          }
          return acc;
        }),
      );

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
      addRewards,
    } satisfies CampaignStore;
  }),
);
