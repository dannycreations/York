import 'dotenv/config';

import { Effect, Layer, Logger, Schema } from 'effect';

import { ConfigStoreLayer, EnvSchema } from './core/Config';
import { TwitchApiLayer } from './services/TwitchApi';
import { TwitchSocketLayer } from './services/TwitchSocket';
import { WatchServiceLayer } from './services/WatchService';
import { CampaignStoreLayer } from './stores/CampaignStore';
import { HttpClientLayer } from './structures/HttpClient';
import { LoggerClientLayer, makeLoggerClient } from './structures/LoggerClient';
import { runMain } from './structures/RuntimeClient';
import { MainWorkflow } from './workflows/MainWorkflow';

const logger = makeLoggerClient({ exception: false, rejection: false });

const BaseLayer = Layer.mergeAll(ConfigStoreLayer, HttpClientLayer, LoggerClientLayer(Logger.defaultLogger, logger));

const AppLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const env = yield* Schema.decodeUnknown(EnvSchema)(process.env).pipe(Effect.orDieWith((error) => new Error(`Invalid Environment: ${error}`)));

    const TwitchApi = TwitchApiLayer(env.AUTH_TOKEN, env.IS_DEBUG);
    const TwitchSocket = TwitchSocketLayer(env.AUTH_TOKEN);

    const ApiLayer = Layer.mergeAll(TwitchApi, TwitchSocket);
    const ServiceLayer = Layer.mergeAll(CampaignStoreLayer, WatchServiceLayer);
    return ServiceLayer.pipe(Layer.provideMerge(ApiLayer));
  }),
);

runMain(MainWorkflow.pipe(Effect.provide(AppLayer)), {
  runtimeBaseLayer: BaseLayer,
});
