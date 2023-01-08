import { Listener } from './Listener'
import { Store } from '@sapphire/pieces'

export class ListenerStore extends Store<Listener> {
	public constructor() {
		super(Listener, { name: 'listeners' })
	}
}
