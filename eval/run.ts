/**
 * Local factorial runner. Drives the model through the ablation ladder
 * (CONDITIONS) x scenarios x repeats, scores every reply, and writes a JSON +
 * Markdown report under eval/results/.
 *
 * LOCAL ONLY (needs credentials). For a credential-free re-score of an existing
 * run, use --replay — that path makes no model calls and is CI-safe.
 *
 * Usage:
 *   node eval/run.ts --conditions none,persona,bookend,full \
 *                    --scenarios en-6,zh-6 --repeat 3
 *   node eval/run.ts --replay eval/results/<ts>/run.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CONDITIONS, runOnce, type Conditions } from "./harness.ts";
import { SCENARIOS, scenarioById, type Scenario } from "./scenarios.ts";
import { aggregate, scoreReply, type ReplyScore } from "./scorer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

interface Record {
	condition: string;
	scenarioId: string;
	lang: "en" | "zh";
	toolCalls: number;
	repeat: number;
	toolStarts: number;
	toolEnds: number;
	narration: string;
	summary: string;
}

interface ScoredRecord extends Record {
	narrationScore: ReplyScore | null;
	summaryScore: ReplyScore | null;
}

function parseArgs(argv: string[]) {
	const out = {
		model: "opencode-go/deepseek-v4.1-flash",
		conditions: ["full"],
		scenarios: ["en-6"],
		repeat: 1,
		thinking: "off" as "off" | "low" | "medium" | "high",
		replay: "" as string,
	};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--model") out.model = next();
		else if (a === "--conditions") out.conditions = next().split(",").map((s) => s.trim()).filter(Boolean);
		else if (a === "--scenarios") out.scenarios = next().split(",").map((s) => s.trim()).filter(Boolean);
		else if (a === "--repeat") {
			const n = Number.parseInt(next(), 10);
			if (!Number.isInteger(n) || n < 1) throw new Error(`--repeat must be a positive integer, got: ${argv[i]}`);
			out.repeat = n;
		}
		else if (a === "--thinking") out.thinking = next() as typeof out.thinking;
		else if (a === "--replay") out.replay = next();
	}
	return out;
}

function scoreRecords(records: Record[]): ScoredRecord[] {
	return records.map((r) => ({
		...r,
		narrationScore: r.narration.trim() ? scoreReply(r.narration, r.lang) : null,
		summaryScore: r.summary.trim() ? scoreReply(r.summary, r.lang) : null,
	}));
}

function renderReport(model: string, scored: ScoredRecord[]): string {
	const conditions = [...new Set(scored.map((r) => r.condition))];
	const lines: string[] = [];
	lines.push(`# whale-chan voice-drift eval`);
	lines.push("");
	lines.push(`- model: \`${model}\``);
	lines.push(`- records: ${scored.length}`);
	lines.push("");
	lines.push("## Summary (aggregated over the spoken summary turn)");
	lines.push("");
	lines.push("| condition | n | summary in-char | narration lang | lang match | slop rate | stage-lang ok | mean voice |");
	lines.push("|---|---|---|---|---|---|---|---|");
	for (const c of conditions) {
		const rows = scored.filter((r) => r.condition === c);
		const summary = aggregate(rows.map((r) => r.summaryScore).filter((s): s is ReplyScore => !!s));
		const narration = aggregate(rows.map((r) => r.narrationScore).filter((s): s is ReplyScore => !!s));
		const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
		const stage = summary.stageLanguageOkRate === null ? "n/a" : pct(summary.stageLanguageOkRate);
		lines.push(
			`| ${c} | ${summary.n} | ${pct(summary.inCharacterRate)} | ${narration.n ? pct(narration.languageMatchedRate) : "n/a"} | ` +
				`${pct(summary.languageMatchedRate)} | ${pct(summary.slopRate)} | ${stage} | ${summary.meanVoiceScore.toFixed(2)} |`,
		);
	}
	lines.push("");
	lines.push("## Per-record detail");
	lines.push("");
	lines.push("| condition | scenario | rep | tools | narration lang | summary in-char | summary slop | summary voice |");
	lines.push("|---|---|---|---|---|---|---|---|");
	for (const r of scored) {
		// Narration is a short pre-tool announcement: judge it on language only.
		// in-character is too harsh there — terse announcements lack markers by nature.
		const nc = r.narrationScore ? (r.narrationScore.languageMatched ? "✅" : "✗") : "—";
		const sc = r.summaryScore ? (r.summaryScore.inCharacter ? "✅" : "✗") : "—";
		const slop = r.summaryScore?.slop.join(", ") || "—";
		const vs = r.summaryScore ? r.summaryScore.voiceScore.toString() : "—";
		lines.push(`| ${r.condition} | ${r.scenarioId} | ${r.repeat} | ${r.toolEnds} | ${nc} | ${sc} | ${slop} | ${vs} |`);
	}
	lines.push("");
	return lines.join("\n");
}

function writeRun(model: string, records: Record[]): void {
	const scored = scoreRecords(records);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = join(HERE, "results", stamp);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "run.json"), JSON.stringify({ model, records: scored }, null, 2));
	const report = renderReport(model, scored);
	writeFileSync(join(dir, "report.md"), report);
	console.log(report);
	console.log(`\nwrote ${join(dir, "run.json")} and report.md`);
}

async function runMatrix(args: ReturnType<typeof parseArgs>): Promise<void> {
	const realAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const modelRuntime = await ModelRuntime.create({
		authPath: join(realAgentDir, "auth.json"),
		modelsPath: join(realAgentDir, "models.json"),
	});
	const [provider, id] = args.model.split("/");
	const model = modelRuntime.getModel(provider, id);
	if (!model) throw new Error(`model not found: ${args.model}`);

	const scenarios: Scenario[] = args.scenarios.map((sid) => {
		const s = scenarioById(sid);
		if (!s) throw new Error(`unknown scenario: ${sid} (have: ${SCENARIOS.map((x) => x.id).join(", ")})`);
		return s;
	});

	const records: Record[] = [];
	for (const cName of args.conditions) {
		const condition = CONDITIONS[cName] as Conditions | undefined;
		if (!condition) throw new Error(`unknown condition: ${cName} (have: ${Object.keys(CONDITIONS).join(", ")})`);
		for (const scenario of scenarios) {
			for (let rep = 1; rep <= args.repeat; rep++) {
				process.stdout.write(`running ${cName} / ${scenario.id} / rep${rep} ... `);
				const result = await runOnce({
					condition,
					scenario,
					model,
					modelRuntime,
					thinkingLevel: args.thinking,
				});
				const narration = result.assistantTexts.length > 1 ? result.assistantTexts[0] : "";
				const summary = result.assistantTexts[result.assistantTexts.length - 1] ?? "";
				records.push({
					condition: cName,
					scenarioId: scenario.id,
					lang: scenario.lang,
					toolCalls: scenario.toolCalls,
					repeat: rep,
					toolStarts: result.toolStarts,
					toolEnds: result.toolEnds,
					narration,
					summary,
				});
				process.stdout.write(`done (${result.toolEnds} tool results)\n`);
			}
		}
	}
	writeRun(args.model, records);
}

function runReplay(file: string): void {
	const data = JSON.parse(readFileSync(file, "utf8")) as { model?: string; records: Record[] };
	const scored = scoreRecords(data.records ?? []);
	const report = renderReport(data.model ?? "(unknown)", scored);
	console.log(report);
	const dir = dirname(file);
	writeFileSync(join(dir, "report.replay.md"), report);
	console.log(`\nwrote ${join(dir, "report.replay.md")} (no model calls)`);
}

const args = parseArgs(process.argv);
if (args.replay) {
	runReplay(args.replay);
} else {
	await runMatrix(args);
}
