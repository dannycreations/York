import { Task } from './Task'
import { Store } from '@sapphire/pieces'

export class TaskStore extends Store<Task> {
	public constructor() {
		super(Task, { name: 'tasks' })
	}
}
