import { truncate } from '@vegapunk/utilities/common';
import { Context, Data, Effect, Layer, Option, Ref } from 'effect';

import { TwitchApiTag } from '../api/TwitchApi';
import { GqlQueries } from '../api/TwitchGql';
import { TwitchSocketTag } from '../api/TwitchSocket';
import { ConfigStoreTag } from '../core/Config';
import { WsTopic } from '../core/Constants';
import { ChannelDropsSchema } from '../core/Schemas';
import { getDropStatus, isMinutesWatchedMet } from '../helpers/TwitchHelper';

import type { TwitchApi, TwitchApiError } from '../api/TwitchApi';
import type { TwitchSocket, TwitchSocketError } from '../api/TwitchSocket';
import type { ClientConfig } from '../core/Config';
import type { Campaign, Channel, Drop, Reward } from '../core/Schemas';

export type CampaignServiceState = Data.TaggedEnum<{
  Initial: {};
  PriorityOnly: {};
  All: {};
}>;

export const CampaignServiceState = Data.taggedEnum<CampaignServiceState>();

const REWARD_EXPIRED_MS = 2_592_000_000;

interface RawDrop {
  readonly id: string;
  readonly name: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly requiredMinutesWatched: number;
  readonly requiredSubs: number;
  readonly benefitEdges: ReadonlyArray<{
    readonly benefit: {
      readonly id: string;
      readonly name?: string | undefined;
    };
  }>;
  readonly self?:
    | {
        readonly isClaimed: boolean;
        readonly hasPreconditionsMet: boolean;
        readonly currentMinutesWatched: number;
        readonly dropInstanceID: string | null;
      }
    | undefined;
}

const processDrop = (
  drop: RawDrop,
  campaignId: string,
  config: ClientConfig,
  rewardsMap: ReadonlyMap<string, Date>,
  now: number,
  allowUpcomingIfHasAward: boolean,
): Option.Option<Drop> => {
  const { startAt, endAt, requiredMinutesWatched, requiredSubs } = drop;
  const isClaimed = requiredSubs > 0 || (drop.self?.isClaimed ?? false);

  if (isClaimed) return Option.none();
  const benefits = drop.benefitEdges.map((e) => e.benefit.id);
  const hasBeenAwarded = benefits.some((benefitId) => {
    const lastAwardedAt = rewardsMap.get(benefitId);
    return lastAwardedAt !== undefined && lastAwardedAt >= startAt;
  });

  if (hasBeenAwarded) return Option.none();

  const currentMinutesWatched = drop.self?.currentMinutesWatched ?? 0;
  const isWatched = drop.self ? isMinutesWatchedMet({ ...drop.self, requiredMinutesWatched }) : false;

  if (isWatched && !config.isClaimDrops) return Option.none();

  const minutesLeft = requiredMinutesWatched - currentMinutesWatched;
  const status = getDropStatus(startAt, endAt, now, minutesLeft);

  if (status.isExpired) return Option.none();
  if (status.isUpcoming && (!allowUpcomingIfHasAward || !drop.self?.dropInstanceID)) return Option.none();

  return Option.some({
    id: drop.id,
    name: truncate((drop.benefitEdges[0]?.benefit.name || drop.name).trim()),
    benefits,
    campaignId,
    startAt,
    endAt,
    requiredMinutesWatched,
    requiredSubs,
    isClaimed,
    hasPreconditionsMet: drop.self?.hasPreconditionsMet ?? true,
    currentMinutesWatched,
    dropInstanceID: drop.self?.dropInstanceID || undefined,
  } satisfies Drop);
};

export interface CampaignService {
  readonly campaigns: Ref.Ref<ReadonlyMap<string, Campaign>>;
  readonly progress: Ref.Ref<ReadonlyArray<Drop>>;
  readonly rewards: Ref.Ref<ReadonlyMap<string, Date>>;
  readonly state: Ref.Ref<CampaignServiceState>;
  readonly updateCampaigns: Effect.Effect<void, TwitchApiError>;
  readonly updateProgress: Effect.Effect<void, TwitchApiError>;
  readonly getSortedActive: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getOffline: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly setBroken: (id: string, isBroken: boolean) => Effect.Effect<void>;
  readonly setOffline: (id: string, isOffline: boolean) => Effect.Effect<void>;
  readonly setPriority: (id: string, priority: number) => Effect.Effect<void>;
  readonly getDropsForCampaign: (campaignId: string) => Effect.Effect<ReadonlyArray<Drop>, TwitchApiError>;
  readonly getChannelsForCampaign: (campaign: Campaign) => Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError>;
  readonly addRewards: (rewards: ReadonlyArray<Reward>) => Effect.Effect<void>;
}

export class CampaignServiceTag extends Context.Tag('@services/CampaignService')<CampaignServiceTag, CampaignService>() {}

const filterChannelsByCampaign = (
  api: TwitchApi,
  channels: readonly Channel[],
  campaignId: string,
): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError> => {
  if (channels.length === 0) return Effect.succeed([]);
  return api
    .graphql(
      channels.map((c) => GqlQueries.channelDrops(c.id)),
      ChannelDropsSchema,
    )
    .pipe(
      Effect.map((responses) => channels.filter((_, i) => responses[i].channel.viewerDropCampaigns?.some((vc) => vc.id === campaignId) ?? false)),
    );
};

const cleanupSocketListeners = (socket: TwitchSocket | undefined, channels: readonly Channel[]): Effect.Effect<void, TwitchSocketError> => {
  if (!socket || channels.length === 0) return Effect.void;
  return Effect.forEach(
    channels,
    (c) =>
      Effect.all(
        [socket.unlisten(WsTopic.ChannelStream, c.id), socket.unlisten(WsTopic.ChannelMoment, c.id), socket.unlisten(WsTopic.ChannelUpdate, c.id)],
        { discard: true },
      ),
    { discard: true },
  );
};

const processOnlineChannels = (
  api: TwitchApi,
  socket: TwitchSocket | undefined,
  campaignId: string,
  channels: readonly Channel[],
): Effect.Effect<ReadonlyArray<Channel>, TwitchApiError | TwitchSocketError> =>
  Effect.gen(function* () {
    const filtered = yield* filterChannelsByCampaign(api, channels, campaignId);
    const filteredIds = new Set(filtered.map((f) => f.id));
    yield* cleanupSocketListeners(
      socket,
      channels.filter((oc) => !filteredIds.has(oc.id)),
    );
    return filtered;
  });

const processInventoryDrops = (
  campaigns: ReadonlyArray<{ readonly id: string; readonly timeBasedDrops: ReadonlyArray<RawDrop> }>,
  config: ClientConfig,
  rewardsMap: ReadonlyMap<string, Date>,
  now: number,
): ReadonlyArray<Drop> => {
  const result: Drop[] = [];
  for (const campaign of campaigns) {
    const drops = [...campaign.timeBasedDrops].sort((a, b) => a.requiredMinutesWatched - b.requiredMinutesWatched);
    const filtered: Drop[] = [];
    for (const d of drops) {
      const opt = processDrop(d, campaign.id, config, rewardsMap, now, true);
      if (Option.isSome(opt)) filtered.push(opt.value);
    }
    const len = filtered.length;
    const totalDrops = drops.length;
    const startIndex = totalDrops - len;
    for (let i = 0; i < len; i++) {
      result.push({ ...filtered[i], name: truncate(`${startIndex + i + 1}/${totalDrops}, ${filtered[i].name}`) });
    }
  }
  return result;
};

export const CampaignServiceLayer: Layer.Layer<CampaignServiceTag, never, TwitchApiTag | ConfigStoreTag | TwitchSocketTag> = Layer.effect(
  CampaignServiceTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStoreTag;
    const socket = yield* Effect.serviceOption(TwitchSocketTag).pipe(Effect.map(Option.getOrUndefined));

    const campaignsRef = yield* Ref.make<ReadonlyMap<string, Campaign>>(new Map());
    const progressRef = yield* Ref.make<ReadonlyArray<Drop>>([]);
    const rewardsRef = yield* Ref.make<ReadonlyMap<string, Date>>(new Map());
    const stateRef = yield* Ref.make<CampaignServiceState>(CampaignServiceState.Initial());

    const updateCampaigns: Effect.Effect<void, TwitchApiError> = Effect.gen(function* () {
      const [response, config] = yield* Effect.all([api.dropsDashboard, configStore.get]);
      const newPriorityGames: string[] = [];

      if (config.usePriorityConnected) {
        for (const data of response.currentUser.dropCampaigns) {
          if (data.game && data.self.isAccountConnected) {
            const gameName = data.game.displayName;
            if (!config.priorityList.has(gameName) && !config.priorityConnectedList.has(gameName)) {
              newPriorityGames.push(gameName);
            }
          }
        }
      }

      if (newPriorityGames.length > 0) {
        yield* configStore.update((c) => ({ ...c, priorityConnectedList: new Set([...c.priorityConnectedList, ...newPriorityGames]) }));
      }

      yield* Ref.update(campaignsRef, (existingMap) => {
        const nextMap = new Map<string, Campaign>();
        for (const data of response.currentUser.dropCampaigns) {
          if (data.game === null) continue;
          const gameName = data.game.displayName;
          if (config.exclusionList.has(gameName)) continue;
          if (config.isPriorityOnly && !config.priorityList.has(gameName)) continue;

          const existing = existingMap.get(data.id);
          nextMap.set(data.id, {
            id: data.id,
            name: truncate((existing?.name || data.name).trim()),
            game: existing?.game || data.game,
            startAt: data.startAt,
            endAt: data.endAt,
            isAccountConnected: data.self.isAccountConnected,
            priority: existing?.priority ?? 0,
            isBroken: existing?.isBroken ?? false,
            isOffline: existing?.isOffline ?? false,
            allowChannels: existing?.allowChannels ?? [],
          });
        }
        return nextMap;
      });
    });

    const syncProgressRef = (newDrops: ReadonlyArray<Drop>, now: number) =>
      Ref.update(progressRef, (current) => {
        const currentMap = new Map(current.map((d) => [d.id, d]));
        let changed = false;

        for (const [id, drop] of currentMap) {
          if (drop.endAt.getTime() < now) {
            currentMap.delete(id);
            changed = true;
          }
        }

        for (const drop of newDrops) {
          const existing = currentMap.get(drop.id);
          const isStateChanged =
            existing &&
            (existing.currentMinutesWatched !== drop.currentMinutesWatched ||
              existing.isClaimed !== drop.isClaimed ||
              existing.dropInstanceID !== drop.dropInstanceID);

          if (!existing || isStateChanged) {
            currentMap.set(drop.id, drop);
            changed = true;
          }
        }

        return changed || currentMap.size !== current.length ? Array.from(currentMap.values()) : current;
      });

    const updateProgress: Effect.Effect<void, TwitchApiError> = Effect.gen(function* () {
      const config = yield* configStore.get;
      const response = yield* api.inventory;
      const now = Date.now();
      const rewardsMap = new Map<string, Date>();

      for (const drop of response.currentUser.inventory.gameEventDrops) {
        if (now - drop.lastAwardedAt.getTime() < REWARD_EXPIRED_MS) {
          rewardsMap.set(drop.id, drop.lastAwardedAt);
        }
      }

      yield* Ref.set(rewardsRef, rewardsMap);
      yield* syncProgressRef(processInventoryDrops(response.currentUser.inventory.dropCampaignsInProgress, config, rewardsMap, now), now);
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
          const existing = map.get(campaignId);
          if (!existing) return map;
          const next = new Map(map);
          next.set(campaignId, {
            ...existing,
            name: truncate(dropDetail.name.trim()),
            game: dropDetail.game || existing.game,
            allowChannels: dropDetail.allow?.channels?.map((c) => c.name) ?? [],
          });
          return next;
        });

        if (!dropDetail.timeBasedDrops || dropDetail.timeBasedDrops.length === 0) return [];

        const rewardsMap = yield* Ref.get(rewardsRef);
        const progress = yield* Ref.get(progressRef);
        const progressMap = new Map(progress.map((d) => [d.id, d]));
        const sortedDrops = [...dropDetail.timeBasedDrops].sort((a, b) => a.requiredMinutesWatched - b.requiredMinutesWatched);
        const config = yield* configStore.get;
        const now = Date.now();
        const activeDrops: Drop[] = [];

        for (const d of sortedDrops) {
          const opt = processDrop(d, campaignId, config, rewardsMap, now, false);
          if (Option.isSome(opt)) {
            const drop = opt.value;
            activeDrops.push({ ...drop, currentMinutesWatched: progressMap.get(drop.id)?.currentMinutesWatched ?? drop.currentMinutesWatched });
          }
        }

        const len = activeDrops.length;
        const totalDrops = sortedDrops.length;
        const startIndex = totalDrops - len;
        const result = activeDrops.map((drop, i) => ({ ...drop, name: truncate(`${startIndex + i + 1}/${totalDrops}, ${drop.name}`) }));

        yield* syncProgressRef(result, now);
        return result;
      });

    const getSortedActive: Effect.Effect<ReadonlyArray<Campaign>> = Effect.gen(function* () {
      const currentState = yield* Ref.get(stateRef);
      const config = yield* configStore.get;
      const now = Date.now();

      const campaigns = Array.from((yield* Ref.get(campaignsRef)).values()).filter((c) => {
        if (c.isBroken || c.isOffline || c.game === null) return false;
        return !getDropStatus(c.startAt, c.endAt, now).isExpired;
      });

      let targets = campaigns;
      if (currentState._tag === 'PriorityOnly') {
        targets = campaigns.filter(
          (c) => c.game !== null && (config.priorityList.has(c.game.displayName) || config.priorityConnectedList.has(c.game.displayName)),
        );
      }

      const result: Campaign[] = [];
      const seenGames = new Set<string>();
      for (const c of targets) {
        if (c.game === null || seenGames.has(c.game.id)) continue;
        seenGames.add(c.game.id);
        result.push(c);
      }

      return result.sort((a, b) => {
        if (a.game !== null && b.game !== null) {
          const aP = config.priorityList.has(a.game.displayName);
          const bP = config.priorityList.has(b.game.displayName);
          if (aP && !bP) return -1;
          if (!aP && bP) return 1;
          const aPC = config.priorityConnectedList.has(a.game.displayName);
          const bPC = config.priorityConnectedList.has(b.game.displayName);
          if (aPC && !bPC) return -1;
          if (!aPC && bPC) return 1;
        }
        return b.priority - a.priority || a.endAt.getTime() - b.endAt.getTime();
      });
    });

    const setCampaignField = (id: string, update: (c: Campaign) => Campaign): Effect.Effect<void> =>
      Ref.update(campaignsRef, (map) => {
        const next = new Map(map);
        const c = next.get(id);
        if (c) next.set(id, update(c));
        return next;
      });

    return {
      campaigns: campaignsRef,
      progress: progressRef,
      rewards: rewardsRef,
      state: stateRef,
      updateCampaigns,
      updateProgress,
      getSortedActive,
      getSortedUpcoming: Effect.gen(function* () {
        const now = Date.now();
        return Array.from((yield* Ref.get(campaignsRef)).values())
          .filter((c) => getDropStatus(c.startAt, c.endAt, now).isUpcoming)
          .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
      }),
      getOffline: Effect.gen(function* () {
        return Array.from((yield* Ref.get(campaignsRef)).values()).filter((c) => c.isOffline);
      }),
      setBroken: (id, isBroken) => setCampaignField(id, (c) => ({ ...c, isBroken })),
      setOffline: (id, isOffline) => setCampaignField(id, (c) => ({ ...c, isOffline })),
      setPriority: (id, priority) => setCampaignField(id, (c) => ({ ...c, priority })),
      getDropsForCampaign,
      getChannelsForCampaign: (campaign) =>
        Effect.gen(function* () {
          if (campaign.game === null) return [];
          const onlineChannels: Channel[] = [];
          if (campaign.allowChannels.length > 0) {
            const res = yield* api.channelStreams(campaign.allowChannels.slice(0, 30));
            for (const u of res.users) {
              if (u.stream) onlineChannels.push({ id: u.id, login: u.login, gameId: campaign.game!.id, isOnline: true });
            }
          } else {
            const res = yield* api.gameDirectory(campaign.game.slug || '');
            for (const e of res.game?.streams.edges ?? []) {
              if (e.node.broadcaster)
                onlineChannels.push({ id: e.node.broadcaster.id, login: e.node.broadcaster.login, gameId: campaign.game!.id, isOnline: true });
            }
          }
          if (onlineChannels.length === 0) return [];
          return yield* processOnlineChannels(api, socket, campaign.id, onlineChannels);
        }),
      addRewards: (rewards) =>
        Ref.update(rewardsRef, (current) => {
          const next = new Map(current);
          for (const r of rewards) next.set(r.id, r.lastAwardedAt);
          return next;
        }),
    } satisfies CampaignService;
  }),
);
