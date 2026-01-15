import { Array, Context, Effect, Layer, Ref } from 'effect';

import { ConfigStore } from '../core/Config';
import { Campaign, Drop, Game, Reward } from '../core/Types';
import { GqlQueries, TwitchApiTag } from './TwitchApi';

export interface CampaignStore {
  readonly campaigns: Ref.Ref<ReadonlyMap<string, Campaign>>;
  readonly progress: Ref.Ref<ReadonlyArray<Drop>>;
  readonly rewards: Ref.Ref<ReadonlyArray<Reward>>;
  readonly updateCampaigns: Effect.Effect<void, any, never>;
  readonly updateProgress: Effect.Effect<void, any, never>;
  readonly getSortedActive: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getSortedUpcoming: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly getOffline: Effect.Effect<ReadonlyArray<Campaign>>;
  readonly setOffline: (id: string, isOffline: boolean) => Effect.Effect<void>;
}

export class CampaignStoreTag extends Context.Tag('@services/CampaignStore')<CampaignStoreTag, CampaignStore>() {}

export const CampaignStoreLayer = Layer.effect(
  CampaignStoreTag,
  Effect.gen(function* () {
    const api = yield* TwitchApiTag;
    const configStore = yield* ConfigStore;
    const campaignsRef = yield* Ref.make<ReadonlyMap<string, Campaign>>(new Map());
    const progressRef = yield* Ref.make<ReadonlyArray<Drop>>([]);
    const rewardsRef = yield* Ref.make<ReadonlyArray<Reward>>([]);

    const updateCampaigns = Effect.gen(function* () {
      const config = yield* configStore.get;
      const response = yield* api.graphql<any>(GqlQueries.dropsDashboard);
      const userId = yield* api.userId;

      const dropCampaigns = response[0].data.currentUser.dropCampaigns;
      const newCampaigns = new Map<string, Campaign>();

      for (const data of dropCampaigns) {
        const gameName = data.game.displayName;
        if (config.exclusionList.has(gameName)) continue;

        if (config.usePriorityConnected && data.self.isAccountConnected) {
          if (!config.priorityList.has(gameName)) {
            yield* configStore.update((c) => ({
              ...c,
              priorityList: new Set([...c.priorityList, gameName]),
            }));
          }
        }

        if (!config.isPriorityOnly || config.priorityList.has(gameName)) {
          const existing = (yield* Ref.get(campaignsRef)).get(data.id);
          let allowChannels: ReadonlyArray<string> = existing?.allowChannels ?? [];
          let campaignName = data.name;
          let game = data.game;

          // Only fetch details if we don't have them yet (parity with legacy)
          if (allowChannels.length === 0) {
            const detailRes = yield* api.graphql<any>(GqlQueries.campaignDetails(data.id, userId));
            const dropDetail = detailRes[0].data.user?.dropCampaign;
            if (dropDetail) {
              allowChannels = dropDetail.allow?.channels?.map((c: any) => c.name) ?? [];
              campaignName = dropDetail.name;
              game = dropDetail.game;
            }
          }

          const campaign: Campaign = {
            id: data.id,
            name: campaignName,
            game: game as Game,
            startAt: new Date(data.startAt),
            endAt: new Date(data.endAt),
            isAccountConnected: data.self.isAccountConnected,
            priority: 0,
            isOffline: false,
            allowChannels,
          };

          newCampaigns.set(campaign.id, campaign);
        }
      }
      yield* Ref.set(campaignsRef, newCampaigns);
    });

    const updateProgress = Effect.gen(function* () {
      const response = yield* api.graphql<any>(GqlQueries.inventory);

      const inventory = response[0].data.currentUser.inventory;
      const gameEventDrops = inventory.gameEventDrops;
      const dropCampaignsInProgress = inventory.dropCampaignsInProgress;

      const newRewards = gameEventDrops.map((d: any) => ({
        id: d.id,
        lastAwardedAt: new Date(d.lastAwardedAt),
      }));
      yield* Ref.set(rewardsRef, newRewards);

      const newProgress: Drop[] = [];
      const currentRewards = yield* Ref.get(rewardsRef);

      for (const campaign of dropCampaignsInProgress) {
        let dropCount = 0;
        const sortedDrops = [...campaign.timeBasedDrops].sort((a: any, b: any) => a.requiredMinutesWatched - b.requiredMinutesWatched);

        for (const data of sortedDrops) {
          const benefits = data.benefitEdges.map((e: any) => e.benefit.id);
          const startAt = new Date(data.startAt);
          const endAt = new Date(data.endAt);

          // Parity with Campaign.ts:141 - filter out already claimed benefits
          const alreadyClaimed = benefits.some((id: string) => currentRewards.some((r) => r.id === id && r.lastAwardedAt >= startAt));
          if (alreadyClaimed && !data.self.isClaimed) continue;

          if (endAt <= new Date()) continue;

          dropCount++;
          newProgress.push({
            id: data.id,
            name: `${dropCount}, ${data.name}`, // Parity with Campaign.ts:148
            benefits,
            campaignId: campaign.id,
            startAt,
            endAt,
            requiredMinutesWatched: data.requiredMinutesWatched,
            isClaimed: data.self.isClaimed,
            hasPreconditionsMet: data.self.hasPreconditionsMet,
            currentMinutesWatched: data.self.currentMinutesWatched,
            dropInstanceID: data.self.dropInstanceID,
          });
        }
      }
      yield* Ref.set(progressRef, newProgress);
    });

    const getSortedActive = Ref.get(campaignsRef).pipe(
      Effect.map((map) =>
        Array.fromIterable(map.values())
          .filter((c) => !c.isOffline && c.endAt > new Date())
          .sort((a, b) => {
            if (a.priority !== b.priority) {
              return b.priority - a.priority;
            }
            return a.endAt.getTime() - b.endAt.getTime();
          }),
      ),
    );

    const getSortedUpcoming = Ref.get(campaignsRef).pipe(
      Effect.map((map) =>
        Array.fromIterable(map.values())
          .filter((c) => c.startAt > new Date())
          .sort((a, b) => a.startAt.getTime() - b.startAt.getTime()),
      ),
    );

    const getOffline = Ref.get(campaignsRef).pipe(Effect.map((map) => Array.fromIterable(map.values()).filter((c) => c.isOffline)));

    const setOffline = (id: string, isOffline: boolean) =>
      Ref.update(campaignsRef, (map) => {
        const next = new Map(map);
        const campaign = next.get(id);
        if (campaign) {
          next.set(id, { ...campaign, isOffline });
        }
        return next;
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
    };
  }),
);
