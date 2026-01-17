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

const logger = createLogger({ exception: false, rejection: false });

const BaseLayer = Layer.mergeAll(ConfigStoreLayer, HttpClientLayer, LoggerClientLayer(Logger.defaultLogger, logger));

const AppLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const env = yield* Schema.decodeUnknown(EnvSchema)(process.env).pipe(Effect.orDieWith((error) => new Error(`Invalid Environment: ${error}`)));

    const TwitchApi = TwitchApiLayer(env.AUTH_TOKEN, env.IS_DEBUG);
    const TwitchSocket = TwitchSocketLayer(env.AUTH_TOKEN);

    const ApiLayer = Layer.mergeAll(TwitchApi, TwitchSocket).pipe(Layer.provideMerge(BaseLayer));
    const ServiceLayer = Layer.mergeAll(CampaignStoreLayer, WatchServiceLayer).pipe(Layer.provideMerge(ApiLayer));

    return ServiceLayer;
  }),
);

runForkWithCleanUp(cycleWithRestart(MainWorkflow.pipe(Effect.provide(AppLayer), Effect.provide(BaseLayer))));
