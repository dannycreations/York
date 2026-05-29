import 'dotenv/config';

import { Config, Effect, Layer } from 'effect';

import { TwitchApiLayer } from './api/TwitchApi';
import { TwitchSocketLayer } from './api/TwitchSocket';
import { ConfigStoreLayer } from './core/Config';
import { CampaignServiceLayer } from './services/CampaignService';
import { DropServiceLayer } from './services/DropService';
import { PointServiceLayer } from './services/PointService';
import { WatchServiceLayer } from './services/WatchService';
import { HttpClientLayer } from './structures/HttpClient';
import { LoggerClientLayer } from './structures/LoggerClient';
import { runMainCycle } from './structures/RuntimeClient';
import { MainWorkflow } from './workflows/MainWorkflow';

const makeMainLayer = (authToken: string, isDebug: boolean) =>
  Layer.suspend(() => {
    const core = Layer.mergeAll(ConfigStoreLayer, HttpClientLayer, LoggerClientLayer());

    const api = TwitchApiLayer(authToken, isDebug).pipe(Layer.provide(core));
    const socket = TwitchSocketLayer(authToken).pipe(Layer.provide(core));
    const infrastructure = Layer.mergeAll(api, socket);

    const campaign = CampaignServiceLayer.pipe(Layer.provide(infrastructure), Layer.provide(core));

    const points = PointServiceLayer.pipe(Layer.provide(infrastructure), Layer.provide(core));
    const drops = DropServiceLayer.pipe(Layer.provide(campaign), Layer.provide(infrastructure), Layer.provide(core));
    const watch = WatchServiceLayer.pipe(Layer.provide(infrastructure), Layer.provide(core));
    const domain = Layer.mergeAll(points, drops, watch);

    return Layer.mergeAll(domain, campaign, infrastructure, core);
  });

const program = Effect.gen(function* () {
  const authToken = yield* Config.string('AUTH_TOKEN');
  const isDebug = yield* Config.boolean('IS_DEBUG').pipe(Config.withDefault(false));

  return yield* MainWorkflow.pipe(Effect.provide(makeMainLayer(authToken, isDebug)));
});

runMainCycle(program);
