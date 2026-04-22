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
import { logger } from '../logger.ts';

import { CopilotPricingSource } from '../pricing.ts';

const TABLE_COLUMN_COUNT = 8;

function groupByDate(events: TokenUsageEvent[]): Map<string, TokenUsageEvent[]> {
	const grouped = new Map<string, TokenUsageEvent[]>();
	for (const event of events) {
		const date = event.timestamp.split('T')[0]!;
		const existing = grouped.get(date);
		if (existing != null) {
			existing.push(event);
		} else {
			grouped.set(date, [event]);
		}
	}
	return grouped;
}

export const dailyCommand = define({
	name: 'daily',
	description: 'Show Copilot CLI token usage grouped by day',
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
		const modeValue = ctx.values.mode ?? 'premium';
		if (modeValue !== 'premium' && modeValue !== 'api') {
			console.error(`Invalid mode "${modeValue}". Use "premium" or "api".`);
			return;
		}
		const pricingMode: PricingMode = modeValue;

		if (jsonOutput) {
			logger.level = 0;
		}

		const { events } = await loadCopilotUsageEvents();

		if (events.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ daily: [], totals: null })
				: 'No Copilot CLI usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using pricingSource = new CopilotPricingSource({ offline: false });

		const eventsByDate = groupByDate(events);

		const dailyData: Array<{
			date: string;
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			totalTokens: number;
			premiumRequests: number;
			premiumCostUSD: number;
			apiCostUSD: number;
			modelsUsed: string[];
		}> = [];

		for (const [date, dayEvents] of eventsByDate) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheReadTokens = 0;
			let cacheWriteTokens = 0;
			let premiumRequests = 0;
			let apiCostUSD = 0;
			const modelsSet = new Set<string>();

			for (const event of dayEvents) {
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
			}

			const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

			dailyData.push({
				date,
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				totalTokens,
				premiumRequests,
				premiumCostUSD: premiumRequests * PREMIUM_REQUEST_COST_USD,
				apiCostUSD,
				modelsUsed: Array.from(modelsSet),
			});
		}

		dailyData.sort((a, b) => a.date.localeCompare(b.date));

		const totals = {
			inputTokens: dailyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: dailyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheReadTokens: dailyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			cacheWriteTokens: dailyData.reduce((sum, d) => sum + d.cacheWriteTokens, 0),
			totalTokens: dailyData.reduce((sum, d) => sum + d.totalTokens, 0),
			premiumRequests: dailyData.reduce((sum, d) => sum + d.premiumRequests, 0),
			premiumCostUSD: dailyData.reduce((sum, d) => sum + d.premiumCostUSD, 0),
			apiCostUSD: dailyData.reduce((sum, d) => sum + d.apiCostUSD, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						daily: dailyData,
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
		console.log(`\n📊 Copilot CLI Token Usage Report - Daily (${modeLabel})\n`);

		const costHeader = pricingMode === 'premium' ? 'Cost (PR)' : 'Cost (API)';

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Date',
				'Models',
				'Input',
				'Output',
				'Cache Write',
				'Cache Read',
				'Total Tokens',
				costHeader,
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Date', 'Models', 'Input', 'Output', costHeader],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of dailyData) {
			const costValue =
				pricingMode === 'premium'
					? formatCurrency(data.premiumCostUSD)
					: formatCurrency(data.apiCostUSD);

			table.push([
				data.date,
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
