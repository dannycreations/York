import { Task } from '@vegapunk/core'
import { _, chalk, sleep } from '@vegapunk/utilities'
import { Tasks } from '../lib/api/constants/Enum'
import { DropCampaign } from '../lib/api/types/ViewerDropsDashboard'
import { RequestType } from '../lib/api/types/WebSocket'
import { ActiveCampaign, Campaign } from '../lib/resolvers/Campaign'
import { QueueStore } from '../lib/stores/QueueStore'
import { DropUpcomingTask } from './DropUpcoming'

export class DropMainTask extends Task {
	public queue: QueueStore<ActiveCampaign>
	public campaign: Campaign

	public constructor(context: Task.LoaderContext) {
		super(context, { name: Tasks.DropMain, delay: 60_000 })
		this.queue = new QueueStore()
		this.campaign = new Campaign()
	}

	public override async runOnInit() {
		await this.run()

		const dropTopic = `user-drop-events.${this.container.twitch.userID}`
		await this.container.ws.send(RequestType.Listen, dropTopic)
	}

	public async run(): Promise<void> {
		super.setDelay(this.options.delay)

		await this.createTask()
		if (this.queue.isSleeping()) {
			this.container.logger.info('')
			return
		}

		const selectCampaign = this.queue.peek()
		if (!selectCampaign) {
			this.campaign.games().shift()
			const id = this.queue.last().id
			_.remove(this.campaign.campaign(), { id })
			this.queue.hasTask(false)
			return this.run()
		}

		const selectDrop = selectCampaign.drops
		if (!selectDrop.peek()) {
			this.queue.dequeue()
			return this.run()
		} else {
			if (selectDrop.isStatus().expired) {
				this.container.logger.info(chalk`{red ${selectCampaign.name}} | Campaigns expired`)
				this.queue.dequeue()
				return this.run()
			}
		}

		const selectStream = selectCampaign.channels
		if (!selectDrop.hasPreconditionsMet()) {
			this.container.logger.info(chalk`{red ${selectDrop.name}} | Preconditions drops`)
			this.queue.dequeue()
			return this.run()
		} else if (selectDrop.hasMinutesWatchedMet()) {
			if (this.container.client.config.isClaimDrops) {
				if (!selectDrop.dropInstanceID) {
					const countLimit = 5
					for (let i = 0; i < countLimit; i++) {
						this.campaign.resetInventory()
						const activeCampaign = await this.campaign.checkCampaign({ dropID: selectCampaign.id })
						Object.assign(selectDrop, activeCampaign.drops)
						if (selectDrop.dropInstanceID) break
						if (!selectDrop.hasMinutesWatchedMet()) {
							if (selectDrop.requiredMinutesWatched - selectDrop.currentMinutesWatched >= 10) {
								this.container.logger.info(chalk`{red ${selectDrop.name}} | Possible broken drops`)
								this.campaign.games().push(activeCampaign.game.displayName)
								this.campaign.campaign().push(activeCampaign as unknown as DropCampaign)
								this.queue.dequeue()
							} else {
								selectStream.dequeue()
							}
							return this.run()
						}

						if (!i) this.container.logger.info(chalk`{red ${selectDrop.name}} | DropID not found`)
						this.container.logger.info(chalk`{yellow Waiting for ${i + 1}/${countLimit} minutes}`)
						await sleep(this.options.delay)
					}
				}
				if (await selectDrop.claimDrops()) {
					selectDrop.setNextPreconditions()
					this.container.logger.info(chalk`{green ${selectDrop.name}} | Drops claimed`)
				}
			}

			this.campaign.resetInventory()
			selectDrop.dequeue()
			return this.run()
		}

		if (await selectStream.watch()) {
			selectDrop.setMinutesWatched()
			const currentMinutes = `${selectDrop.currentMinutesWatched}/${selectDrop.requiredMinutesWatched}`
			this.container.logger.info(chalk`{green ${selectDrop.name}} | ${selectStream.login} | ${currentMinutes}`)

			if (this.container.client.config.isClaimPoints) {
				if (await selectStream.claimPoints()) {
					this.container.logger.info(chalk`{green ${selectStream.login}} | Points claimed`)
				}
			}
		} else {
			const id = selectCampaign.id
			if (!~this.campaign.offline().findIndex((r) => r.id === id)) {
				const game = selectCampaign.game.displayName
				this.campaign.offline().push({ id, game })
			}

			this.container.logger.info(chalk`{red ${selectCampaign.name}} | Offline`)
			this.queue.dequeue()
			return this.run()
		}
	}

	async createTask(): Promise<void> {
		this.queue.isSleeping(false)
		if (this.queue.hasTask()) return

		if (this.queue.isState() === 3 && !this.campaign.games().length) {
			super.stopTask()
			this.queue.isState(1)
			this.queue.isSleeping(true)
			this.campaign.resetInventory()

			const taskStores = this.container.stores.get('tasks')
			const upcomingTask = taskStores.get(Tasks.DropUpcoming) as DropUpcomingTask
			return upcomingTask.run()
		}

		await this.campaign.fetchCampaign()

		let isNewFetch = false
		if (this.queue.isState() === 1 && !this.campaign.games().length) {
			isNewFetch = true
			this.queue.isState(2)

			const priorityList = [...new Set(this.container.client.config.priorityList)]
			const gameList = this.campaign
				.campaign()
				.map((r) => r.game.displayName)
				.filter((r) => !!~priorityList.indexOf(r))
			this.campaign.games([...gameList, ..._.difference(priorityList, gameList)])
		}

		if (this.queue.isState() === 2 && !this.campaign.games().length) {
			isNewFetch = true
			this.queue.isState(3)

			if (this.container.client.config.isDropPriorityOnly) return this.createTask()

			const gameList = this.campaign.campaign().map((r) => r.game.displayName)
			this.campaign.games(_.difference(gameList, this.container.client.config.priorityList))
		}

		if (isNewFetch) {
			const isPriority = this.queue.isState() === 2 ? '' : 'Non-'
			this.container.logger.info(chalk`{bold.yellow Checking ${[...new Set(this.campaign.games())].length} ${isPriority}Priority game!}`)
		}

		loopGameList: while (this.campaign.games().length) {
			let isActiveCampaign = false
			for (const campaign of this.campaign.campaign()) {
				if (this.campaign.games()[0] !== campaign.game.displayName) continue

				const activeCampaign = await this.campaign.checkCampaign({ dropID: campaign.id })
				if (!activeCampaign.drops.peek()) {
					isActiveCampaign = true
					this.campaign.games()[0] = campaign.name
					_.remove(this.campaign.campaign(), { id: campaign.id })
					break
				}

				this.queue.hasTask(true)
				this.queue.enqueue(activeCampaign)
				this.container.logger.info(chalk`{green ${activeCampaign.name}} | Found ${activeCampaign.drops.length} drops`)
				break loopGameList
			}

			this.container.logger.info(chalk`{red ${this.campaign.games()[0]}} | No active ${isActiveCampaign ? 'drops' : 'campaigns'}`)
			this.campaign.games().shift()
		}

		if (!this.queue.hasTask()) return this.createTask()
	}
}
