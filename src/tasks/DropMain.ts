import chalk from 'chalk'
import { Tasks } from '../lib/types/Enum'
import { Task } from '../lib/structures/Task'
import { QueueStore } from '../lib/stores/QueueStore'
import { sortBy, difference, remove, uniqBy } from 'lodash'
import { getTimezoneDate, hasMobileAuth } from '../lib/utils/util'
import { ActiveCampaign, Campaign } from '../lib/resolvers/Campaign'

export class DropMainTask extends Task {
	public queue: QueueStore<ActiveCampaign>
	public campaign: Campaign
	public isFetch?: boolean
	public isPriority?: boolean

	public constructor(context: Task.Context) {
		super(context, { name: Tasks.DropMain, delay: 6e4 })
		this.queue = new QueueStore()
		this.campaign = new Campaign()
	}

	public async runOnInit(): Promise<void> {
		return this.run()
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
			await this.campaign.fetchInventory()

			if (hasMobileAuth() && this.container.config.isClaimDrops) {
				if (!selectDrop.dropInstanceID) {
					this.queue.dequeue()
					this.queue.enqueue(await this.campaign.checkCampaign({ dropID: selectCampaign.id }))
				}
				if (await selectDrop.claimDrops()) {
					selectDrop.setNextPreconditions()
					this.container.logger.info(chalk`{green ${selectDrop.name}} | Drops claimed`)
				}
			}

			selectDrop.dequeue()
			return this.run()
		}

		const selectStream = selectCampaign.channels
		if (await selectStream.watch()) {
			selectDrop.addMinutesWatched()
			const currentMinutes = `${selectDrop.currentMinutesWatched}/${selectDrop.requiredMinutesWatched}`
			this.container.logger.info(chalk`{green ${selectDrop.name}} | ${selectStream.login} | ${currentMinutes}`)

			if (hasMobileAuth() && this.container.config.isClaimPoints) {
				if (await selectStream.claimPoints()) {
					this.container.logger.info(chalk`{green ${selectStream.login}} | Points claimed`)
				}
			}

			if (selectDrop.hasMinutesWatchedMet()) return this.run()
		} else {
			const id = selectCampaign.id
			const game = selectCampaign.game
			this.campaign.offlineList(uniqBy([...this.campaign.offlineList(), { id, game }], 'id'))

			this.container.logger.info(chalk`{red ${selectCampaign.name}} | Offline`)
			this.queue.dequeue()
			return this.run()
		}
	}

	async createTask(): Promise<void> {
		this.isFetch = false
		this.queue.isSleeping(false)

		if (this.queue.isTask()) return
		if (this.isPriority === undefined) {
			this.isFetch = true
			this.isPriority = true
			this.campaign.gameList([...new Set(this.container.config.priorityList)])
		}

		if (!this.campaign.gameList().length) {
			if (this.container.config.isDropPriorityOnly || !this.isPriority) {
				this.queue.isSleeping(true)
				this.isPriority = undefined

				this.campaign.gameList([])
				this.campaign.campaignList([])

				const upcomingList = sortBy(this.campaign.upcomingList(), 'startAt')
				const selectCampaign = upcomingList.shift()
				if (!selectCampaign) {
					this.container.logger.info(chalk`{bold.yellow No upcoming campaigns, Finally I can sleep well}`)
					process.exit()
				}

				const currentDate = new Date()
				const upcomingDate = new Date(selectCampaign.startAt)
				const sleepTime = Math.max(0, +upcomingDate - +currentDate)
				if (!sleepTime) {
					this.container.logger.info(chalk`{bold.yellow ${selectCampaign.game}} | {strikethrough Upcoming}`)
					super.setDelay(1000)
					return
				}

				const sleepUntil = getTimezoneDate(upcomingDate).format('lll')
				this.container.logger.info(chalk`{bold.yellow No active campaigns} | ${upcomingList.length} upcoming`)
				this.container.logger.info(chalk`{bold.yellow Sleeping until ${sleepUntil}}`)

				super.setDelay(sleepTime)
				return
			}

			this.isFetch = true
			this.isPriority = false
			const gameList = this.campaign.campaignList().map((r) => r.game.displayName)
			this.campaign.gameList(difference(gameList, this.container.config.priorityList))
		}

		if (this.isFetch) {
			const isPriority = this.isPriority ? '' : 'Non-'
			this.container.logger.info(chalk`{bold.yellow Fetching ${[...new Set(this.campaign.gameList())].length} ${isPriority}Priority game!}`)
		}

		await this.campaign.fetchCampaign()
		if (this.isPriority) {
			const gameList = this.campaign
				.campaignList()
				.map((r) => r.game.displayName)
				.filter((r) => !!~this.campaign.gameList().indexOf(r))
			this.campaign.gameList([...gameList, ...difference(this.campaign.gameList(), gameList)])
		}

		loopGameList: while (this.campaign.gameList().length) {
			let isActiveCampaign = false
			for (const campaign of this.campaign.campaignList()) {
				if (campaign.game.displayName !== this.campaign.gameList()[0]) continue

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
