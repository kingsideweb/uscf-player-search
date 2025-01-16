import * as cheerio from 'cheerio';

/*
	USChessInfo represents the information to
	be scraped from the uschess.com website
*/
type USChessInfo = {
	playerName: string;
	playerId: string;
	playerState: string;
	regularRating: string;
	quickRating: string;
	blitzRating: string;
	expirationDt: string;
}

/*
	PlayerStatus indicates the status of a player's
	membership, as well as the time until expiration.
*/
type PlayerStatus = {

	/*
		expired is true if the expiration date scraped
		from uschess.com is in the past.
	*/
	expired: boolean;

	/*
		expiresIn is the number of milliseconds until the
		player's membership expires. This will be used to
		coordinate automatic renewal of memberships
	*/
	expiresIn: number | null;
};

/*
	PlayerEligibility indicates whether a player is eligible
	to participate in rated games, and if not, the reason why.
*/
type PlayerEligibility = {
	eligible: boolean;
	reason: string;
};

/*
	PlayerData represents the data to be returned to Make
	and stored in Memberstack. Its the result of this
	worker
*/
type PlayerData = {
	id: string;
	data: USChessInfo;
	elibility: PlayerEligibility;
};

const EmptyUSChessInfo = {
	playerName: '--',
	playerId: '--',
	playerState: '--',
	regularRating: '--',
	quickRating: '--',
	blitzRating: '--',
	expirationDt: '--',
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const id = url.searchParams.get('memberId');

		if (!id || id.trim().length === 0) {
			const memberInfo = {
				id: null,
				eligibility: {
					eligible: false,
					reason: 'player_missing_id'
				},
				data: EmptyUSChessInfo
			}

			return new Response(JSON.stringify(memberInfo), {
				status: 200,
				headers: {
					'content-type': 'application/json',
				},
			});
		}

		try {
			const memberInfo = await getMemberInformation(id);
			return new Response(JSON.stringify(memberInfo), {
				status: 200,
				headers: {
					'content-type': 'application/json',
				},
			});
		} catch (error: any) {
			const memberInfo = {
				id: null,
				eligibility: {
					eligible: false,
					reason: 'error'
				},
				data: EmptyUSChessInfo
			}
			return new Response(JSON.stringify(memberInfo), {
				status: 200,
				headers: {
					'content-type': 'application/json',
				},
			});
		}
	},
};

async function getMemberInformation(id: string) {
	const url = new URL('https://www.uschess.org/msa/MbrDtlMain.php');

	url.search = id;

	const response = await fetch(url.toString());

	if (!response.ok) {
		throw new Error(`Failed to fetch member information for ID ${id}`);
	}

	const htmlContent = await response.text();

	const chessInfo = extractChessInfo(htmlContent);

	const playerStatus = {
		expired: chessInfo.expirationDt ? new Date(chessInfo.expirationDt) < new Date() : false,
		expiresIn: chessInfo.expirationDt ? new Date(chessInfo.expirationDt).getTime() - Date.now() : null,
	}

	// determine eligibility
	const eligibility = determineEligibility(id, chessInfo, playerStatus);

	return {
		id,
		eligibility,
		data: chessInfo
	};
}

function determineEligibility(requestedId: string, playerInfo: USChessInfo, playerStatus: PlayerStatus) {

	// If the player wasn't found, they are not eligible
	if (playerInfo.playerId === '--') {
		return {
			eligible: false,
			reason: 'player_not_found'
		};
	}

	// If a player's membership has expired, they are not eligible
	if (playerStatus.expired) {
		return {
			eligible: false,
			reason: 'player_expired'
		};
	}

	// If the player ID doesn't match the requested ID, they are not eligible
	if (requestedId !== playerInfo.playerId) {
		return {
			eligible: false,
			reason: 'player_invalid'
		};
	}

	// If any of the required fields are missing, they are not eligible
	// Non-critical fields are: playerState, quickRating, blitzRating
	if (
		playerInfo.playerName === '--' ||
		playerInfo.regularRating === '--' ||
		playerInfo.expirationDt === '--'
	) {
		return {
			eligible: false,
			reason: 'player_insufficient_info'
		};
	}

	return {
		eligible: true,
		reason: 'player_valid'
	};
}

function extractChessInfo(htmlContent: string): USChessInfo {
	const $ = cheerio.load(htmlContent);

	// Check for error message
	const errorMessage = $('font[color="A00000"] b').text().trim();
	const isInvalid = errorMessage.includes('Error') || errorMessage.includes('Could not retrieve data');

	if (isInvalid) {
		return {
			playerName: '--',
			playerId: '--',
			playerState: '--',
			regularRating: '--',
			quickRating: '--',
			blitzRating: '--',
			expirationDt: '--'
		}
	}

	// Extract id and name
	const idAndName = $('font[size="+1"] b').text().split(': ');
	const id = idAndName[0];
	const fullName = idAndName[1];

	// Extract ratings
	const ratings: { [key: string]: string } = {};
	$('tr').each((_, row) => {
		const cells = $(row).find('td');
		if (cells.length >= 2) {
			const ratingType = $(cells[0]).text().trim();
			if (['Regular Rating', 'Quick Rating', 'Blitz Rating'].includes(ratingType)) {
				const ratingValue = $(cells[1]).find('b').text().trim().split(' ')[0];
				ratings[ratingType] = ratingValue;
			}
		}
	});

	// Extract State
	const stateFields = $('td:contains("State")').next('td').find('b').text().trim().split('\n');
	const state = stateFields[1]

	// Extract Expiration Date
	const expirationDate = $('td:contains("Expiration Dt.")').next('td').find('b').text().trim();

	return {
		playerName: fullName || '--',
		playerId: id || '--',
		playerState: state || '--',
		regularRating: ratings['Regular Rating'] || '--',
		quickRating: ratings['Quick Rating'] || '--',
		blitzRating: ratings['Blitz Rating'] || '--',
		expirationDt: expirationDate || '--'
	};
}
