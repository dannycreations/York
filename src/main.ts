import 'dotenv/config';

import { Effect, Layer, Logger, LogLevel, Schema } from 'effect';

import { ConfigStoreLayer, EnvSchema } from './core/Config';
import { CampaignStoreLayer } from './services/CampaignStore';
import { TwitchApiLayer } from './services/TwitchApi';
import { TwitchSocketLayer } from './services/TwitchSocket';
import { WatchServiceLayer } from './services/WatchService';
import { HttpClientLayer } from './structures/HttpClient';
import { createLogger, LoggerClientLayer } from './structures/LoggerClient';
import { runForkWithCleanUp } from './structures/RuntimeClient';
import { MainWorkflow } from './workflows/MainWorkflow';

const MainLayer = Effect.gen(function* () {
  const env = yield* Schema.decodeUnknown(EnvSchema)(process.env);

  const logger = createLogger();
  const LoggerLayer = LoggerClientLayer(Logger.defaultLogger, logger);

  const TwitchApi = TwitchApiLayer(env.AUTH_TOKEN);
  const TwitchSocket = TwitchSocketLayer(env.AUTH_TOKEN);

  return Layer.mergeAll(ConfigStoreLayer, HttpClientLayer, LoggerLayer, TwitchApi, TwitchSocket, CampaignStoreLayer, WatchServiceLayer);
}).pipe(Layer.unwrapEffect);

const program = MainWorkflow.pipe(Logger.withMinimumLogLevel(LogLevel.Info));

runForkWithCleanUp(Effect.provide(program, MainLayer));
