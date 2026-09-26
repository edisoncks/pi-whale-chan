/**
 * End-to-end probe: does the "load this repo's extension + fake tool + headless
 * model run" pipeline work at all? Not a measurement yet — it prints one
 * transcript so a human can eyeball whether the voice drifts after tool output.
 *
 * Run:  node eval/probe.ts [provider/id] [toolCalls]
 *   e.g. node eval/probe.ts opencode-go/deepseek-v4.1-flash 6
 *
 * Why the resolve hook: index.ts imports "./persona.js" (a NodeNext .js specifier
 * that points at a .ts file). Node does not rewrite that itself, so we remap it,
 * exactly like test/bookend.test.mjs does.
 */
// Side-effect import: installs the NodeNext ".js -> .ts" resolve hook before the
// dynamic import of index.ts below.
import "./shared.ts";
import { registerProbeTool } from "./shared.ts";

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const REAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const MODEL_SPEC = process.argv[2] ?? "opencode-go/deepseek-v4.1-flash";
const TOOL_CALLS = Number.parseInt(process.argv[3] ?? "6", 10);

async function main() {
	// Isolate resource discovery (and the whale-chan state file) from the real
	// agent dir, but keep credentials: ModelRuntime gets an explicit authPath.
	const sandbox = mkdtempSync(join(tmpdir(), "whale-eval-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = sandbox;

	// The outer finally owns the env override and the sandbox, so a throw from
	// model resolution, reload() or createAgentSession() cannot leak either one.
	try {
		const { default: whaleChan } = await import(pathToFileURL(join(REPO, "index.ts")).href);

		const modelRuntime = await ModelRuntime.create({
			authPath: join(REAL_AGENT_DIR, "auth.json"),
			modelsPath: join(REAL_AGENT_DIR, "models.json"),
		});
		const [provider, id] = MODEL_SPEC.split("/");
		const model = modelRuntime.getModel(provider, id);
		if (!model) throw new Error(`model not found: ${MODEL_SPEC}`);

		const resourceLoader = new DefaultResourceLoader({
			cwd: sandbox,
			agentDir: sandbox,
			extensionFactories: [
				(pi: any) => whaleChan(pi),
				registerProbeTool,
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: sandbox,
			agentDir: sandbox,
			model,
			modelRuntime,
			thinkingLevel: "off",
			resourceLoader,
			sessionManager: SessionManager.inMemory(sandbox),
			noTools: "builtin",
		});

		const assistantTexts: string[] = [];
		let toolCalls = 0;
		let toolResults = 0;
		session.subscribe((event: any) => {
			if (event.type === "tool_execution_start") toolCalls += 1;
			if (event.type === "tool_execution_end") toolResults += 1;
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const text = (event.message.content ?? [])
					.filter((b: any) => b.type === "text")
					.map((b: any) => b.text)
					.join("");
				if (text.trim()) assistantTexts.push(text);
			}
		});

		const prompt =
			`Use the probe_fetch tool exactly ${TOOL_CALLS} times, once for each id from "1" to "${TOOL_CALLS}". ` +
			`After the last tool result, reply in one short paragraph telling me what you just did. ` +
			`Do not call the tool again after that.`;

		try {
			console.log(`model=${MODEL_SPEC} toolCalls=${TOOL_CALLS}`);
			console.log(`active tools: ${JSON.stringify(session.getActiveToolNames())}`);
			console.log(`\n--- user ---\n${prompt}\n`);
			await session.prompt(prompt);
			console.log(`--- tool starts: ${toolCalls} | tool ends: ${toolResults} ---`);
			console.log(`--- assistant turns: ${assistantTexts.length} ---`);
			assistantTexts.forEach((t, i) => console.log(`\n[assistant ${i + 1}]\n${t}`));
		} finally {
			session.dispose();
		}
	} finally {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(sandbox, { recursive: true, force: true });
	}
}

await main();
