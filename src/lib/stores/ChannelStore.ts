import { container } from '@vegapunk/core'
import { ActiveLiveChannel } from '../api/TwitchApi'
import { Queue } from './internal/Queue'

export class ChannelStore extends Queue<ActiveLiveChannel> {
	public constructor(private gameID?: string) {
		super()
	}

	public get login() {
		return super.peek().login
	}

	public async isLive(id: string): Promise<ActiveLiveChannel | null> {
		const stream = await container.twitch.stream(id)
		if (!stream || !stream.data.length) return null

		const isGame = stream.data[0].game_id === this.gameID
		if (this.gameID && !isGame) return null

		const login = stream.data[0].user_login
		const channel_id = stream.data[0].user_id
		return { login, channel_id }
	}

	public async watch(): Promise<boolean> {
		const selectStream = super.peek()
		if (!selectStream) return false

		const stream = await this.isLive(selectStream.channel_id)
		if (!stream) {
			super.dequeue()
			return this.watch()
		}

		Object.assign(selectStream, stream)
		const watch = await container.twitch.watch(selectStream)
		if (!watch) {
			super.dequeue()
			return this.watch()
		}
		return true
	}

	public async claimPoints() {
		const selectStream = super.peek()
		if (!selectStream) return false

		const channelPoints = await container.twitch.channelPoints(selectStream.login)
		const claimID = channelPoints.data.community.channel.self.communityPoints.availableClaim?.id
		if (!claimID) return false

		const channelID = selectStream.channel_id
		await container.twitch.claimPoints({ channelID, claimID })
		return true
	}
}
