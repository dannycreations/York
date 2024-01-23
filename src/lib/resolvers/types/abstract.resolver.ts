export abstract class AbstractResolver {
	public abstract fetch(): void | Promise<void>
	public abstract reset(): void | Promise<void>
}
