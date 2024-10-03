import * as puppeteer from '@cloudflare/puppeteer';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		let id = env.BROWSER.idFromName('browser');
		let obj = env.BROWSER.get(id);
		let resp = await obj.fetch(request.url);
		return resp;
	},
};

const KEEP_BROWSER_ALIVE_IN_SECONDS = 60;

export class Browser {
	private state: DurableObjectState;
	private env: Env;
	private keptAliveInSeconds: number;
	private storage: DurableObjectStorage;
	private browser: puppeteer.Browser | null;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
		this.keptAliveInSeconds = 0;
		this.storage = this.state.storage;
		this.browser = null;
	}

	async fetch(request: Request): Promise<Response> {
		if (!this.browser || !(await this.browser.isConnected())) {
			console.log(`Browser DO: Starting new instance`);
			try {
				this.browser = await puppeteer.launch(this.env.MYBROWSER);
			} catch (e) {
				console.log(`Browser DO: Could not start browser instance. Error: ${e}`);
				return new Response('Error starting browser', { status: 500 });
			}
		}

		// Reset keptAlive after each call to the DO
		this.keptAliveInSeconds = 0;

		const page = await this.browser.newPage();

		let response = null;

		try {
			const memberId = new URL(request.url).searchParams.get('memberId');
			const memberIds = new URL(request.url).searchParams.get('memberIds');

			if (memberId && !memberIds) {
				response = await getMemberInformation(memberId, page);
			}

			if (memberIds && !memberId) {
				const ids = memberIds.split(',');

				if (ids.length > 5) {
					return new Response('Too many memberIds provided. Can process up to 5 per request.', { status: 400 });
				}

				response = {
					ids,
					members: []
				} as {
					ids: Array<string>
					members: Array<{
						id: string,
						data: {
							regularRating: string | null,
							quickRating: string | null,
							blitzRating: string | null,
							state: string | null,
							expirationDt: string | null,
						},
						status: {
							expired: boolean,
							expiresIn: number | null,
						}
					}>
				}

				for (const id of ids) {
					const member = await getMemberInformation(id, page);
					response.members.push(member);
				}
			}

			if (!memberId && !memberIds) {
				return new Response('No memberId or memberIds query parameter provided', { status: 400 });
			}

			if (memberId && memberIds) {
				return new Response('Both memberId and memberIds query parameters provided. Please provide only one.', { status: 400 });
			}

			await page.close();

			// Set the first alarm to keep DO alive
			let currentAlarm = await this.storage.getAlarm();
			if (currentAlarm == null) {
				console.log(`Browser DO: setting alarm`);
				const TEN_SECONDS = 10 * 1000;
				await this.storage.setAlarm(Date.now() + TEN_SECONDS);
			}

			return new Response(JSON.stringify(response, null, 2), {
				headers: { 'Content-Type': 'application/json' },
			});
		} catch (error) {
			console.error('Scraping failed:', error);
			await page.close();
			return new Response(`Scraping failed: ${error.message}`, { status: 500 });
		}
	}

	async alarm(): Promise<void> {
		this.keptAliveInSeconds += 10;
		// Extend browser DO life
		if (this.keptAliveInSeconds < KEEP_BROWSER_ALIVE_IN_SECONDS) {
			console.log(`Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`);
			await this.storage.setAlarm(Date.now() + 10 * 1000);
			// You could ensure the ws connection is kept alive by requesting something
			// or just let it close automatically when there is no work to be done
			// for example, `await this.browser.version()`
		} else {
			console.log(`Browser DO: exceeded life of ${KEEP_BROWSER_ALIVE_IN_SECONDS}s.`);
			if (this.browser) {
				console.log(`Closing browser.`);
				await this.browser.close();
			}
		}
	}
}

async function getMemberInformation(id: string, page: puppeteer.Page) {
	const url = new URL('https://www.uschess.org/msa/MbrDtlMain.php');

	url.search = id;

	await page.goto(url.href, { waitUntil: 'networkidle0' });

	async function extractRating(page: puppeteer.Page, ratingType: string, valueMatcher: (value: string) => string = (value) => value) {
		const selector = `table[bgcolor="FFFFFF"][width="764"] table[cellspacing="9"] tr`;
		const rows = await page.$$(selector);

		for (const row of rows) {
			const rowText = await row.evaluate((el) => el.textContent);
			if (rowText && rowText === ratingType) {
				const cells = await row.$$('td');
				if (cells.length >= 2) {
					return cells[1].evaluate((el) => el.textContent?.trim() || null).then((value) => (value ? valueMatcher(value.replace('\n', '')) : null));
				}
			}
		}
		return null;
	}

	const regularRating = await extractRating(page, 'Regular Rating', (value) => value.split(' ')[0]);
	const quickRating = await extractRating(page, 'Quick Rating', (value) => value.split(' ')[0]);
	const blitzRating = await extractRating(page, 'Blitz Rating', (value) => value.split(' ')[0]);
	const state = await extractRating(page, 'State');
	const expirationDt = await extractRating(page, 'Expiration Dt.');

	return {
		id,
		data: {
			regularRating,
			quickRating,
			blitzRating,
			state,
			expirationDt,
		},
		status: {
			expired: expirationDt ? new Date(expirationDt) < new Date() : false,
			expiresIn: expirationDt ? new Date(expirationDt).getTime() - Date.now() : null,
		},
	};
}