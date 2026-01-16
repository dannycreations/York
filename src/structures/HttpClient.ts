import { lookup } from 'node:dns/promises';
import { defaultsDeep } from '@vegapunk/utilities/common';
import { isErrorLike } from '@vegapunk/utilities/result';
import { Context, Data, Effect, Layer, Schedule } from 'effect';
import got from 'got';
import UserAgent from 'user-agents';

import type { CancelableRequest, Got, Options, Response } from 'got';

/**
 * Represents errors occurring during HTTP requests.
 */
export class HttpClientError extends Data.TaggedError('HttpClientError')<{
  readonly message: string;
  readonly code?: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

/**
 * List of network error codes that are considered retryable.
 */
export const ERROR_CODES: readonly string[] = [
  'EADDRINUSE',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ERR_CANCELED',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
];

/**
 * List of HTTP status codes that are considered retryable.
 */
export const ERROR_STATUS_CODES: readonly number[] = [408, 413, 429, 500, 502, 503, 504, 521, 522, 524];

/**
 * Extended options for HTTP requests, compatible with `got`.
 */
export interface DefaultOptions extends Omit<Options, 'prefixUrl' | 'retry' | 'timeout' | 'resolveBodyOnly'> {
  readonly retry?: number;
  readonly timeout?: Partial<{
    readonly initial: number;
    readonly transmission: number;
    readonly total: number;
  }>;
}

/**
 * Interface defining the HTTP client service.
 */
export interface HttpClient {
  readonly request: <T = string>(options: string | DefaultOptions) => Effect.Effect<Response<T>, HttpClientError>;
  readonly waitForConnection: (total?: number) => Effect.Effect<void, HttpClientError>;
}

/**
 * Context tag for the HttpClient service.
 */
export class HttpClientTag extends Context.Tag('@structures/HttpClient')<HttpClientTag, HttpClient>() {}

const gotInstance: Got = got.bind(got);
const userAgent = new UserAgent({ deviceCategory: 'desktop' });

/**
 * Determines if an error is a timeout exception.
 *
 * @param error - The error to check.
 */
export const isErrorTimeout = (error: unknown): boolean =>
  isErrorLike<{ _tag: string; code?: string }>(error) && (error._tag === 'TimeoutException' || error.code === 'ETIMEDOUT');

/**
 * Executes an HTTP request with automatic retries and timeout management.
 *
 * @template T - The expected response body type.
 * @param options - Request options or a URL string.
 * @returns An Effect that resolves to the HTTP response.
 */
const requestFn = <T = string>(options: string | DefaultOptions): Effect.Effect<Response<T>, HttpClientError> =>
  Effect.gen(function* () {
    const isString = typeof options === 'string';
    const payload = defaultsDeep({}, isString ? { url: options } : options, {
      headers: { 'user-agent': userAgent.toString() },
      http2: true,
    });

    const retryCount = isString ? 3 : (options.retry ?? 3);
    const { initial = 10_000, transmission = 30_000, total = 60_000 } = payload.timeout || {};

    return yield* Effect.tryPromise({
      try: (signal) => {
        const promise = gotInstance({
          ...payload,
          retry: 0,
          timeout: {
            lookup: initial,
            connect: initial,
            secureConnect: initial,
            socket: transmission,
            response: transmission,
            send: transmission,
            request: total,
          },
          resolveBodyOnly: false,
        });

        signal.addEventListener(
          'abort',
          () => {
            if ('cancel' in promise) {
              (promise as CancelableRequest<Response<T>>).cancel();
            }
          },
          { once: true },
        );

        return promise as unknown as Promise<Response<T>>;
      },
      catch: (error) => {
        if (isErrorLike<{ message?: string; code?: string; response?: { statusCode?: number } }>(error)) {
          const response = error.response;
          return new HttpClientError({
            message: error.message || 'Request failed',
            code: error.code,
            status: response ? response.statusCode : undefined,
            cause: error,
          });
        }
        return new HttpClientError({
          message: String(error),
          cause: error,
        });
      },
    }).pipe(
      Effect.retry({
        while: (error: unknown) => {
          if (!(error instanceof HttpClientError)) return false;
          const isNetworkError = !!error.code && ERROR_CODES.includes(error.code);
          const isRetryableStatus = !!error.status && ERROR_STATUS_CODES.includes(error.status);
          return isNetworkError || isRetryableStatus || isErrorTimeout(error);
        },
        schedule: retryCount < 0 ? Schedule.forever : Schedule.recurs(retryCount),
      }),
    );
  });

/**
 * Waits for an internet connection by performing DNS lookups and captive portal checks.
 *
 * @param retryMs - The interval in milliseconds between connection checks.
 * @returns An Effect that resolves when a connection is established.
 */
const waitForConnectionFn = (retryMs: number = 10_000): Effect.Effect<void, HttpClientError> =>
  Effect.gen(function* () {
    const checkGoogle = Effect.tryPromise({
      try: () => lookup('google.com'),
      catch: (error) =>
        new HttpClientError({
          message: 'DNS lookup failed',
          code: 'ENOTFOUND',
          cause: error,
        }),
    });

    const checkApple = requestFn({
      url: 'https://captive.apple.com/hotspot-detect.html',
      headers: { 'user-agent': 'CaptiveNetworkSupport/1.0 wispr' },
      timeout: { total: retryMs },
    });

    return yield* Effect.raceAll([checkGoogle, checkApple]).pipe(Effect.retry({ schedule: Schedule.spaced(`${retryMs} millis`) }), Effect.asVoid);
  });

/**
 * Helper to execute an HTTP request using the HttpClient service from the environment.
 */
export const request = <T = string>(options: string | DefaultOptions) => Effect.flatMap(HttpClientTag, (service) => service.request<T>(options));

/**
 * Helper to wait for an internet connection using the HttpClient service from the environment.
 */
export const waitForConnection = (total?: number) => Effect.flatMap(HttpClientTag, (service) => service.waitForConnection(total));

/**
 * Layer providing the HttpClient service.
 */
export const HttpClientLayer: Layer.Layer<HttpClientTag> = Layer.succeed(
  HttpClientTag,
  HttpClientTag.of({
    request: requestFn,
    waitForConnection: waitForConnectionFn,
  }),
);
