export abstract class AbstractResolver {
	public abstract fetch(): PromiseLike<void> | void
	public abstract reset(): PromiseLike<void> | void
}
