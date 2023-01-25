import chalk from 'chalk'
import delay from 'delay'
import { Tasks } from '../lib/types/Enum'
import { difference, remove } from 'lodash'
import { Task } from '../lib/structures/Task'
import { DropUpcomingTask } from './DropUpcoming'
import { QueueStore } from '../lib/stores/QueueStore'
import { RequestType } from '../lib/types/twitch/WebSocket'
import { hasMobileAuth, processRestart } from '../lib/utils/util'
import { ActiveCampaign, Campaign } from '../lib/resolvers/Campaign'

export class DropMainTask extends Task {
	public queue: QueueStore<ActiveCampaign>
	public campaign: Campaign

	public constructor(context: Task.Context) {
		super(context, { name: Tasks.DropMain, delay: 6e4 })
		this.queue = new QueueStore()
		this.campaign = new Campaign()
	}

	public async runOnInit(): Promise<void> {
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
			this.campaign.gameList().shift()
			this.campaign.campaignList().shift()
			this.queue.isTask(false)
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

		if (!selectDrop.hasPreconditionsMet()) {
			this.container.logger.info(chalk`{red ${selectDrop.name}} | Preconditions drops`)
			this.queue.dequeue()
			return this.run()
		} else if (selectDrop.hasMinutesWatchedMet()) {
			if (hasMobileAuth() && this.container.config.isClaimDrops) {
				if (!selectDrop.dropInstanceID) {
					const countLimit = 5
					for (let i = 0; i < countLimit; i++) {
						this.campaign.resetInventory()
						const activeCampaign = await this.campaign.checkCampaign({ dropID: selectCampaign.id })
						Object.assign(selectDrop, activeCampaign.drops)
						if (selectDrop.dropInstanceID) break
						if (!selectDrop.hasMinutesWatchedMet()) return this.run()

						if (!i) this.container.logger.info(chalk`{red ${selectDrop.name}} | DropID not found`)
						this.container.logger.info(chalk`{yellow Waiting for ${i + 1}/${countLimit} minutes}`)
						await delay(6e4)
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

		const selectStream = selectCampaign.channels
		if (await selectStream.watch()) {
			selectDrop.setMinutesWatched()
			const currentMinutes = `${selectDrop.currentMinutesWatched}/${selectDrop.requiredMinutesWatched}`
			this.container.logger.info(chalk`{green ${selectDrop.name}} | ${selectStream.login} | ${currentMinutes}`)

			if (hasMobileAuth() && this.container.config.isClaimPoints) {
				if (await selectStream.claimPoints()) {
					this.container.logger.info(chalk`{green ${selectStream.login}} | Points claimed`)
				}
			}
		} else {
			const id = selectCampaign.id
			if (!~this.campaign.offlineList().findIndex((r) => r.id === id)) {
				const game = selectCampaign.game.displayName
				this.campaign.offlineList().push({ id, game })
			}

			this.container.logger.info(chalk`{red ${selectCampaign.name}} | Offline`)
			this.queue.dequeue()
			return this.run()
		}
	}

	async createTask(): Promise<void> {
		this.queue.isSleeping(false)
		if (this.queue.isTask()) return
		if (this.campaign.gameList().length !== this.campaign.campaignList().length) {
			this.container.logger.info(chalk`{bold.red Campaigns maybe corrupted} | Restarting`)
			return processRestart()
		}

		if (this.queue.isState() === 3 && !this.campaign.gameList().length) {
			this.queue.isState(1)
			this.queue.isSleeping(true)
			this.campaign.resetInventory()

			const stores = this.container.stores.get('tasks')
			;(stores.get(Tasks.DropUpcoming) as DropUpcomingTask).run()
			return super.stopTask()
		}

		await this.campaign.fetchCampaign()

		let isNewFetch = false
		if (this.queue.isState() === 1 && !this.campaign.gameList().length) {
			isNewFetch = true
			this.queue.isState(2)

			const priorityList = [...new Set(this.container.config.priorityList)]
			const gameList = this.campaign
				.campaignList()
				.map((r) => r.game.displayName)
				.filter((r) => !!~priorityList.indexOf(r))
			this.campaign.gameList([...gameList, ...difference(priorityList, gameList)])
		}

		if (this.queue.isState() === 2 && !this.campaign.gameList().length) {
			isNewFetch = true
			this.queue.isState(3)

			if (this.container.config.isDropPriorityOnly) return this.createTask()

			const gameList = this.campaign.campaignList().map((r) => r.game.displayName)
			this.campaign.gameList(difference(gameList, this.container.config.priorityList))
		}

		if (isNewFetch) {
			const isPriority = this.queue.isState() === 2 ? '' : 'Non-'
			this.container.logger.info(chalk`{bold.yellow Checking ${[...new Set(this.campaign.gameList())].length} ${isPriority}Priority game!}`)
		}

		loopGameList: while (this.campaign.gameList().length) {
			let isActiveCampaign = false
			for (const campaign of this.campaign.campaignList()) {
				if (this.campaign.gameList()[0] !== campaign.game.displayName) continue

				const activeCampaign = await this.campaign.checkCampaign({ dropID: campaign.id })
				if (!activeCampaign.drops.peek()) {
					isActiveCampaign = true
					this.campaign.gameList()[0] = campaign.name
					remove(this.campaign.campaignList(), { id: campaign.id })
					break
				}

				this.queue.isTask(true)
				this.queue.enqueue(activeCampaign)
				this.container.logger.info(chalk`{green ${activeCampaign.name}} | Found ${activeCampaign.drops.length} drops`)
				break loopGameList
			}

			this.container.logger.info(chalk`{red ${this.campaign.gameList()[0]}} | No active ${isActiveCampaign ? 'drops' : 'campaigns'}`)
			this.campaign.gameList().shift()
		}

		if (!this.queue.isTask()) return this.createTask()
	}
}
