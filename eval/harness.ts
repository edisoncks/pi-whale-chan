/**
 * Session harness: build a headless Pi session with (a) THIS repo's extension,
 * loaded with an explicit mechanism ablation, and (b) a deterministic fake tool.
 * Returns the raw assistant texts; scoring lives in scorer.ts so this file stays
 * model-shaped and credential-free.
 *
 * LOCAL ONLY. Creating a session needs provider credentials (ModelRuntime reads
 * the real auth.json). Nothing here belongs in CI — see eval/README.md.
 */
// Side-effect import: installs the NodeNext ".js -> .ts" resolve hook (index.ts
// imports "./persona.js") before index.ts is dynamically imported below.
import "./shared.ts";
import { registerProbeTool } from "./shared.ts";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	createAgentSession,
	DefaultResourceLoader,
	type ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Scenario } from "./scenarios.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const { default: whaleChan } = await import(pathToFileURL(join(REPO, "index.ts")).href);

/** Mechanism flags, mirroring index.ts's `WhaleMechanisms`. */
export interface Conditions {
	persona: boolean;
	headRule: boolean;
	tailAnchor: boolean;
}

/**
 * Ablation ladder. `none` is the flat-assistant baseline; each rung adds one
 * mechanism so the effect of each can be read off the delta.
 */
export const CONDITIONS: Record<string, Conditions> = {
	none: { persona: false, headRule: false, tailAnchor: false },
	persona: { persona: true, headRule: false, tailAnchor: false },
	bookend: { persona: true, headRule: true, tailAnchor: false },
	full: { persona: true, headRule: true, tailAnchor: true }, // production default
};

export interface RunResult {
	/** Assistant texts in order: [narration?, ..., summary]. */
	assistantTexts: string[];
	toolStarts: number;
	toolEnds: number;
}

export async function runOnce(opts: {
	condition: Conditions;
	scenario: Scenario;
	model: unknown;
	modelRuntime: ModelRuntime;
	thinkingLevel?: "off" | "low" | "medium" | "high";
}): Promise<RunResult> {
	const sandbox = mkdtempSync(join(tmpdir(), "whale-eval-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	// Isolate resource discovery and the whale-chan state file from the real dir.
	// Credentials are supplied explicitly to ModelRuntime, not via this env var.
	process.env.PI_CODING_AGENT_DIR = sandbox;

	const resourceLoader = new DefaultResourceLoader({
		cwd: sandbox,
		agentDir: sandbox,
		extensionFactories: [
			(pi: any) => whaleChan(pi, opts.condition),
			registerProbeTool,
		],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: sandbox,
		agentDir: sandbox,
		model: opts.model,
		modelRuntime: opts.modelRuntime,
		thinkingLevel: opts.thinkingLevel ?? "off",
		resourceLoader,
		sessionManager: SessionManager.inMemory(sandbox),
		noTools: true, // built-in tools off; the registered probe_fetch stays active
	});

	const assistantTexts: string[] = [];
	let toolStarts = 0;
	let toolEnds = 0;
	session.subscribe((event: any) => {
		if (event.type === "tool_execution_start") toolStarts += 1;
		else if (event.type === "tool_execution_end") toolEnds += 1;
		else if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = (event.message.content ?? [])
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join("");
			if (text.trim()) assistantTexts.push(text);
		}
	});

	try {
		await session.prompt(opts.scenario.prompt);
	} finally {
		session.dispose();
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(sandbox, { recursive: true, force: true });
	}

	return { assistantTexts, toolStarts, toolEnds };
}
