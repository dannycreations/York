export class QueryStore {
	private queryList: QueryRequest[][] = []

	public add({ key, data, hash, query }: QueryAlias): QueryStore {
		let i = this.queryList.length ? this.queryList.length - 1 : 0
		if (this.queryList[i]?.length >= 30) i++

		this.queryList[i] ??= []

		const json: QueryRequest = {
			operationName: key,
			variables: data ?? {},
		}

		if (hash) {
			json.extensions = {
				persistedQuery: {
					version: 1,
					sha256Hash: hash,
				},
			}
		} else if (query) {
			json.query = query
		}

		this.queryList[i].push(json)
		return this
	}

	public hasNext(): boolean {
		return !!this.queryList.length
	}

	public next(): string {
		const json = JSON.stringify(this.queryList[0])
		this.queryList.shift()
		return json
	}
}

export interface QueryAlias {
	key: string
	data?: object
	query?: string
	hash?: string
}

export interface QueryRequest<T = {}> {
	operationName: string
	variables: T
	query?: string
	extensions?: {
		persistedQuery: {
			version: number
			sha256Hash: string
		}
	}
}
