import { container } from '@vegapunk/core'
import { ActiveLiveChannel } from '../api/TwitchApi'
import { Queue } from '../database/Queue'

export class ChannelStore extends Queue<ActiveLiveChannel> {
	public constructor(private gameID?: string) {
		super()
	}

	public get login(): string {
		return super.peek()!.login
	}

	public async isLive(id: string): Promise<ActiveLiveChannel | null> {
		const helix = await container.twitch.helix(id)
		if (!helix || !helix.data.length) return null

		const isGame = helix.data[0].game_id === this.gameID
		if (this.gameID && !isGame) return null

		const login = helix.data[0].user_login
		const channel_id = helix.data[0].user_id
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
		return container.twitch.watch(selectStream)
	}

	public async claimPoints(): Promise<boolean> {
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
