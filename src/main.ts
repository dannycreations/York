import 'dotenv/config';

import { Config, Effect, Layer } from 'effect';

import { ConfigStoreLayer } from './core/Config';
import { TwitchApiLayer } from './services/TwitchApi';
import { TwitchSocketLayer } from './services/TwitchSocket';
import { CampaignStoreLayer } from './stores/CampaignStore';
import { HttpClientLayer } from './structures/HttpClient';
import { LoggerClientLayer } from './structures/LoggerClient';
import { runMainCycle } from './structures/RuntimeClient';
import { MainWorkflow } from './workflows/MainWorkflow';

const AppLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const authToken = yield* Config.string('AUTH_TOKEN');
    const isDebug = yield* Config.boolean('IS_DEBUG').pipe(Config.withDefault(false));

    const TwitchApi = TwitchApiLayer(authToken, isDebug);
    const TwitchSocket = TwitchSocketLayer(authToken);

    const ApiLayer = Layer.mergeAll(TwitchApi, TwitchSocket);

    return CampaignStoreLayer.pipe(Layer.provideMerge(ApiLayer));
  }),
);

const BaseLayer = Layer.mergeAll(ConfigStoreLayer, HttpClientLayer);

const MainLayer = AppLayer.pipe(Layer.provideMerge(BaseLayer), Layer.provideMerge(LoggerClientLayer()));

runMainCycle(MainWorkflow.pipe(Effect.provide(MainLayer)));
