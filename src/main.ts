import 'dotenv/config';

import { Effect, Layer, Logger, Schema } from 'effect';

import { ConfigStoreLayer, EnvSchema } from './core/Config';
import { CampaignStoreLayer } from './services/CampaignStore';
import { TwitchApiLayer } from './services/TwitchApi';
import { TwitchSocketLayer } from './services/TwitchSocket';
import { WatchServiceLayer } from './services/WatchService';
import { HttpClientLayer } from './structures/HttpClient';
import { createLogger, LoggerClientLayer } from './structures/LoggerClient';
import { cycleWithRestart, runForkWithCleanUp } from './structures/RuntimeClient';
import { MainWorkflow } from './workflows/MainWorkflow';

const MainLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const env = yield* Schema.decodeUnknown(EnvSchema)(process.env);

    const logger = createLogger();
    const LoggerLayer = LoggerClientLayer(Logger.defaultLogger, logger);

    const TwitchApi = TwitchApiLayer(env.AUTH_TOKEN, env.IS_DEBUG);
    const TwitchSocket = TwitchSocketLayer(env.AUTH_TOKEN);

    const BaseLayer = Layer.mergeAll(ConfigStoreLayer, HttpClientLayer, LoggerLayer);
    const ApiLayer = Layer.mergeAll(TwitchApi, TwitchSocket).pipe(Layer.provide(BaseLayer));
    const ServiceLayer = Layer.mergeAll(CampaignStoreLayer, WatchServiceLayer).pipe(Layer.provide(ApiLayer), Layer.provide(BaseLayer));

    return Layer.mergeAll(BaseLayer, ApiLayer, ServiceLayer);
  }),
);

runForkWithCleanUp(cycleWithRestart(MainWorkflow.pipe(Effect.provide(MainLayer))));
