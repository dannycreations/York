import { Store } from '@sapphire/pieces'
import { Task } from './Task'
import { TaskLoaderStrategy } from './TaskLoaderStrategy'

export class TaskStore extends Store<Task, 'tasks'> {
	public constructor() {
		super(Task, { name: 'tasks', strategy: new TaskLoaderStrategy() })
	}
}
