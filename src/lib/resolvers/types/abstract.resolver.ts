export abstract class AbstractResolver {
	abstract fetch(): Promise<void>
	abstract reset(): Promise<void>
}
