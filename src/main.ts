import 'dotenv/config';

import { Config, Effect, Layer } from 'effect';

import { TwitchApiLayer } from './api/TwitchApi.js';
import { TwitchSocketLayer } from './api/TwitchSocket.js';
import { ConfigStoreLayer } from './core/Config.js';
import { DebugLayer } from './core/Debug.js';
import { CampaignServiceLayer } from './services/CampaignService.js';
import { DropServiceLayer } from './services/DropService.js';
import { PointServiceLayer } from './services/PointService.js';
import { HttpClientLayer } from './structures/HttpClient.js';
import { LoggerClientLayer } from './structures/LoggerClient.js';
import { cycleUntilMidnight, runMainCycle } from './structures/RuntimeClient.js';
import { MainWorkflow } from './workflows/MainWorkflow.js';

const logger = LoggerClientLayer();

const makeMainLayer = (authToken: string, isDebug: boolean) => {
  const core = Layer.mergeAll(ConfigStoreLayer, HttpClientLayer, DebugLayer(isDebug), logger);
  const infrastructure = Layer.mergeAll(TwitchApiLayer(authToken), TwitchSocketLayer(authToken)).pipe(Layer.provideMerge(core));
  const campaign = CampaignServiceLayer.pipe(Layer.provideMerge(infrastructure));

  return Layer.mergeAll(PointServiceLayer, DropServiceLayer).pipe(Layer.provideMerge(campaign));
};

const program = Effect.gen(function* () {
  const authToken = yield* Config.string('AUTH_TOKEN');
  const isDebug = yield* Config.boolean('IS_DEBUG').pipe(Config.withDefault(false));

  const mainLayer = makeMainLayer(authToken, isDebug);

  yield* Effect.all([cycleUntilMidnight, MainWorkflow], { concurrency: 'unbounded' }).pipe(Effect.provide(mainLayer));
});

runMainCycle(program, { logger });
