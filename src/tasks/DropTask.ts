import { Task } from '@vegapunk/core'

export class DropTask extends Task {
	public constructor(context: Task.LoaderContext) {
		super(context, { delay: 60_000 })
	}

	public async update() {
		const dataDrops = await this.container.dropRepository.find({})
		if (dataDrops.length) {
			this.container.logger.info(dataDrops[0], 'DropTask')
		}
	}
}
