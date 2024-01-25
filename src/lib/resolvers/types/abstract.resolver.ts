import { Awaitable } from '@sapphire/utilities'

export abstract class AbstractResolver {
	public abstract fetch(): Awaitable<void>
	public abstract reset(): Awaitable<void>
}
