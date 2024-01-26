export function sleep<T = undefined>(ms: number, value?: T, options?: SleepOptions) {
	return new Promise<T>((resolve, reject) => {
		const signal = options?.signal
		if (signal) {
			if (signal.aborted) {
				reject(signal.reason)
				return
			}

			signal.addEventListener('abort', () => {
				clearTimeout(timer)
				reject(signal.reason)
			})
		}

		const timer: NodeJS.Timeout | number = setTimeout(() => resolve(value!), ms)
		if (options?.ref === false && typeof timer === 'object') {
			timer.unref()
		}
	})
}

export function sleepUntil(fun: () => boolean, ms: number = 20) {
	return new Promise<boolean>((resolve) => {
		const wait = setInterval(() => {
			if (fun()) {
				clearInterval(wait)
				resolve(true)
			}
		}, ms)
	})
}

export interface SleepOptions {
	signal?: AbortSignal | undefined
	ref?: boolean | undefined
}
