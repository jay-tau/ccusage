import type { PricingMode } from '../_consts.ts';
import type { TokenUsageEvent } from '../_types.ts';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { define } from 'gunshi';
import pc from 'picocolors';
import { PREMIUM_REQUEST_COST_USD } from '../_consts.ts';
import { loadCopilotUsageEvents } from '../data-loader.ts';

import { CopilotPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 8;

function groupBySession(events: TokenUsageEvent[]): Map<string, TokenUsageEvent[]> {
	const grouped = new Map<string, TokenUsageEvent[]>();
	for (const event of events) {
		const existing = grouped.get(event.sessionId);
		if (existing != null) {
			existing.push(event);
		} else {
			grouped.set(event.sessionId, [event]);
		}
	}
	return grouped;
}

export const sessionCommand = define({
	name: 'session',
	description: 'Show Copilot CLI token usage grouped by session',
	args: {
		json: {
			type: 'boolean',
			short: 'j',
			description: 'Output in JSON format',
		},
		compact: {
			type: 'boolean',
			description: 'Force compact table mode',
		},
		mode: {
			type: 'string',
			short: 'm',
			description: 'Pricing mode: "premium" (default, $0.04/request) or "api" (official API rates)',
			default: 'premium',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const pricingMode = (ctx.values.mode ?? 'premium') as PricingMode;

		const { events, sessions } = await loadCopilotUsageEvents();

		if (events.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ sessions: [], totals: null })
				: 'No Copilot CLI usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using pricingSource = new CopilotPricingSource({ offline: false });

		const eventsBySession = groupBySession(events);

		const sessionData: Array<{
			sessionId: string;
			repository: string;
			cwd: string;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			totalTokens: number;
			premiumRequests: number;
			premiumCostUSD: number;
			apiCostUSD: number;
			modelsUsed: string[];
			lastActivity: string;
		}> = [];

		for (const [sessionId, sessionEvents] of eventsBySession) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheReadTokens = 0;
			let cacheWriteTokens = 0;
			let premiumRequests = 0;
			let apiCostUSD = 0;
			const modelsSet = new Set<string>();
			let lastActivity = sessionEvents[0]!.timestamp;

			for (const event of sessionEvents) {
				inputTokens += event.inputTokens;
				outputTokens += event.outputTokens;
				cacheReadTokens += event.cacheReadTokens;
				cacheWriteTokens += event.cacheWriteTokens;
				premiumRequests += event.premiumRequestCost;

				if (pricingMode === 'api') {
					const cost = await pricingSource.calculateCost(event.model, {
						inputTokens: event.inputTokens,
						outputTokens: event.outputTokens,
						cacheReadTokens: event.cacheReadTokens,
						cacheWriteTokens: event.cacheWriteTokens,
					});
					apiCostUSD += cost;
				}
				modelsSet.add(event.model);

				if (event.timestamp > lastActivity) {
					lastActivity = event.timestamp;
				}
			}

			const totalTokens = inputTokens + outputTokens;
			const sessionMeta = sessions.get(sessionId);

			sessionData.push({
				sessionId,
				repository: sessionMeta?.repository ?? '',
				cwd: sessionMeta?.cwd ?? '',
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				totalTokens,
				premiumRequests,
				premiumCostUSD: premiumRequests * PREMIUM_REQUEST_COST_USD,
				apiCostUSD,
				modelsUsed: Array.from(modelsSet),
				lastActivity,
			});
		}

		sessionData.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));

		const totals = {
			inputTokens: sessionData.reduce((sum, s) => sum + s.inputTokens, 0),
			outputTokens: sessionData.reduce((sum, s) => sum + s.outputTokens, 0),
			cacheReadTokens: sessionData.reduce((sum, s) => sum + s.cacheReadTokens, 0),
			cacheWriteTokens: sessionData.reduce((sum, s) => sum + s.cacheWriteTokens, 0),
			totalTokens: sessionData.reduce((sum, s) => sum + s.totalTokens, 0),
			premiumRequests: sessionData.reduce((sum, s) => sum + s.premiumRequests, 0),
			premiumCostUSD: sessionData.reduce((sum, s) => sum + s.premiumCostUSD, 0),
			apiCostUSD: sessionData.reduce((sum, s) => sum + s.apiCostUSD, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						sessions: sessionData,
						totals,
						mode: pricingMode,
					},
					null,
					2,
				),
			);
			return;
		}

		const modeLabel = pricingMode === 'premium' ? 'Premium Requests' : 'API Equivalent';
		// eslint-disable-next-line no-console
		console.log(`\n📊 Copilot CLI Token Usage Report - Sessions (${modeLabel})\n`);

		const costHeader = pricingMode === 'premium' ? 'Cost (PR)' : 'Cost (API)';

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Session',
				'Models',
				'Input',
				'Output',
				'Cache Write',
				'Cache Read',
				'Total Tokens',
				costHeader,
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Session', 'Models', 'Input', 'Output', costHeader],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of sessionData) {
			const displayLabel =
				data.repository !== ''
					? data.repository
					: (data.cwd.split('/').pop() ?? data.sessionId.slice(0, 8));

			const truncatedLabel =
				displayLabel.length > 30 ? `${displayLabel.slice(0, 27)}...` : displayLabel;

			const costValue =
				pricingMode === 'premium'
					? formatCurrency(data.premiumCostUSD)
					: formatCurrency(data.apiCostUSD);

			table.push([
				truncatedLabel,
				formatModelsDisplayMultiline(data.modelsUsed),
				formatNumber(data.inputTokens),
				formatNumber(data.outputTokens),
				formatNumber(data.cacheWriteTokens),
				formatNumber(data.cacheReadTokens),
				formatNumber(data.totalTokens),
				costValue,
			]);
		}

		const totalCost = pricingMode === 'premium' ? totals.premiumCostUSD : totals.apiCostUSD;

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totals.inputTokens)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(formatNumber(totals.cacheWriteTokens)),
			pc.yellow(formatNumber(totals.cacheReadTokens)),
			pc.yellow(formatNumber(totals.totalTokens)),
			pc.yellow(formatCurrency(totalCost)),
		]);

		// eslint-disable-next-line no-console
		console.log(table.toString());

		if (table.isCompactMode()) {
			// eslint-disable-next-line no-console
			console.log('\nRunning in Compact Mode');
			// eslint-disable-next-line no-console
			console.log('Expand terminal width to see cache metrics and total tokens');
		}
	},
});
