import 'dotenv/config';

import { Config, Effect, Layer, Logger } from 'effect';

import { ConfigStoreLayer } from './core/Config';
import { TwitchApiLayer } from './services/TwitchApi';
import { TwitchSocketLayer } from './services/TwitchSocket';
import { WatchServiceLayer } from './services/WatchService';
import { CampaignStoreLayer } from './stores/CampaignStore';
import { HttpClientLayer } from './structures/HttpClient';
import { LoggerClientLayer, makeLoggerClient } from './structures/LoggerClient';
import { runMainCycle } from './structures/RuntimeClient';
import { MainWorkflow } from './workflows/MainWorkflow';

const logger = makeLoggerClient();

const BaseLayer = Layer.mergeAll(ConfigStoreLayer, HttpClientLayer, LoggerClientLayer(Logger.defaultLogger, logger));

const AppLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const authToken = yield* Config.string('AUTH_TOKEN');
    const isDebug = yield* Config.boolean('IS_DEBUG').pipe(Config.withDefault(false));

    const TwitchApi = TwitchApiLayer(authToken, isDebug);
    const TwitchSocket = TwitchSocketLayer(authToken);

    const ApiLayer = Layer.mergeAll(TwitchApi, TwitchSocket);
    const ServiceLayer = Layer.mergeAll(CampaignStoreLayer, WatchServiceLayer);

    return ServiceLayer.pipe(Layer.provideMerge(ApiLayer));
  }),
);

runMainCycle(MainWorkflow.pipe(Effect.provide(AppLayer), Effect.provide(BaseLayer)));
