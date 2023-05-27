import { Queue } from '../database/Queue'
import { Constants } from '../types/Enum'
import { container } from '@sapphire/pieces'
import { ActiveLiveChannel } from '../api/TwitchApi'

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

		// const adRequest = (await container.twitch.adRequest(login))[0]
		// const hasStream = adRequest.data.user?.stream
		// const isGame = hasStream?.game?.id === this.gameID
		// const isTag = hasStream?.tags.find((r) => r.id === Constants.DropTag)
		// if (!hasStream || (this.gameID && (!isGame || !isTag))) return null
		// const broadcast_id = hasStream.id
		// const channel_id = adRequest.data.user!.id

		const isGame = helix.data[0].game_id === this.gameID
		// const isTag = helix.data[0].tags.find((r) => !!~r.indexOf('Drop'))
		if (this.gameID && !isGame) return null

		const login = helix.data[0].user_login
		const channel_id = helix.data[0].user_id
		const broadcast_id = helix.data[0].id

		return { login, channel_id, broadcast_id }
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

		await container.twitch.watch(selectStream)
		return true
	}

	/**
	 * ! TODO: Bypass integrity check
	 * @see {@link TwitchApi#integrity}
	 * @see {@link TwitchGql#useMobileAuth}
	 */
	public async claimPoints(): Promise<boolean> {
		const selectStream = super.peek()
		if (!selectStream) return false

		const channelPoints = await container.twitch.channelPoints(selectStream.login)
		const claimID = channelPoints[0].data.community.channel.self.communityPoints.availableClaim?.id
		if (!claimID) return false

		const channelID = selectStream.channel_id
		await container.twitch.claimPoints({ channelID, claimID })
		return true
	}
}
