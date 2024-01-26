import { LoaderStrategy } from '@sapphire/pieces'
import type { Task } from './Task'
import type { TaskStore } from './TaskStore'

export class TaskLoaderStrategy extends LoaderStrategy<Task> {
	public override onLoad(_store: TaskStore, piece: Task) {
		piece['_run'](true).then(() => piece['_loop']())
	}

	public override onUnload(_store: TaskStore, piece: Task) {
		piece.stopTask()
	}
}
