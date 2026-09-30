/**
 * PERSONA.md injection regression test.
 *
 * The extension appends the bundled PERSONA.md to Pi's `appendSystemPrompt`
 * option — the same channel APPEND_SYSTEM.md uses — so it renders as the
 * `addendum` section. This file pins:
 *
 * - the persona lands in `appendSystemPrompt`, after any user APPEND_SYSTEM.md
 *   content, separated by a blank line;
 * - injection is idempotent and reversible, even on a hypothetical shared
 *   options object (Pi clones per turn, so the real path is already clean);
 * - the base options Pi reuses are never mutated;
 * - the legacy `whale_persona` section / prompt guideline / `context` tail
 *   anchor are gone.
 *
 * It runs the real extension through Node's native TS support; the resolve hook
 * only remaps `./pet.js` -> `./pet.ts` (Node does not rewrite `.js`
 * specifiers itself); compiled `.js` inside node_modules is left untouched.
 *
 * The render assertion reads Pi's internal `dist/core/system-prompt.js`, which
 * is not in the package's `exports` map. That access is OPTIONAL: if Pi
 * reshuffles `dist/`, the render test skips with a clear reason instead of
 * hard-failing the suite on a dependency bump. The behavior tests stay
 * independent and always run. Set WHALE_TEST_FORCE_NO_INTERNALS=1 to exercise
 * that skip path locally.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.endsWith(".js")) {
			try {
				const url = new URL(specifier, context.parentURL);
				const tsUrl = new URL(url.href.replace(/\.js$/, ".ts"));
				if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(tsUrl))) {
					return { url: tsUrl.href, shortCircuit: true };
				}
			} catch {
				// fall through to the default resolver
			}
		}
		return nextResolve(specifier, context);
	},
});

// Sandbox persistence: getAgentDir() reads PI_CODING_AGENT_DIR. Must be set
// before session_start / command handlers run so nothing touches the real dir.
const sandbox = mkdtempSync(join(tmpdir(), "whale-chan-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

const { default: whaleChan } = await import("../index.ts");
const PERSONA = readFileSync(new URL("../PERSONA.md", import.meta.url), "utf8").trim();

// The exports map hides ./dist/core/*, so resolve the package entry first and
// load the renderer from its sibling. This lets us assert on the ACTUAL rendered
// `<addendum>` section, not just the string the extension sets.
//
// Internal access is OPTIONAL. `dist/core/system-prompt.js` is not a public
// subpath, so a Pi release could move or rename it. We probe a few likely
// locations and validate the exports; if the API is gone, SP stays null and the
// render-dependent test skips rather than crashing the whole file at import
// time. The behavior tests never touch SP.
async function loadSystemPromptInternals() {
	if (process.env.WHALE_TEST_FORCE_NO_INTERNALS) return null; // test hook: exercise the skip path
	try {
		const base = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		for (const candidate of [
			join(base, "core", "system-prompt.js"),
			join(base, "core", "system-prompt.mjs"),
			join(base, "system-prompt.js"),
		]) {
			if (!existsSync(candidate)) continue;
			const mod = await import(pathToFileURL(candidate).href);
			if (
				typeof mod.normalizeBuildSystemPromptOptions === "function" &&
				typeof mod.buildSystemPromptSections === "function"
			) {
				return mod;
			}
		}
	} catch {
		// fall through: internals unavailable or reshaped
	}
	return null;
}

const SP = await loadSystemPromptInternals();
const NEEDS_INTERNALS = SP
	? undefined
	: "Pi internals unavailable: dist/core/system-prompt.js missing or reshaped — update this test, not the extension";
if (!SP) {
	console.warn(`[persona.test] ${NEEDS_INTERNALS}`);
}

function makeHarness() {
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		// Avatar plumbing: the factory registers these, but this file never drives
		// a message flow (and its ctx has no `mode`), so the stubs stay inert.
		registerEntryRenderer() {},
		appendEntry() {},
	};
	whaleChan(pi);
	const ctx = { ui: { notify() {} } };
	return { handlers, commands, ctx };
}

/** Run the real `before_agent_start` handler against `options`. */
function run(handlers, ctx, options) {
	return handlers.get("before_agent_start")(
		{ type: "before_agent_start", systemPromptOptions: options },
		ctx,
	);
}

test("PERSONA.md is injected into appendSystemPrompt", async () => {
	const { handlers, ctx } = makeHarness();
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	const options = { appendSystemPrompt: "" };

	await run(handlers, ctx, options);

	assert.equal(options.appendSystemPrompt, PERSONA);
});

test("a user APPEND_SYSTEM.md is preserved and the persona is appended after it", async () => {
	const { handlers, ctx } = makeHarness();
	const options = { appendSystemPrompt: "USER APPEND" };

	await run(handlers, ctx, options);

	assert.equal(options.appendSystemPrompt, `USER APPEND\n\n${PERSONA}`);
});

test("injection is idempotent on a shared object", async () => {
	// Hypothetical: Pi stopped cloning and handed every turn the SAME object.
	// withPersona strips the prior copy first, so the section stays one copy.
	const { handlers, ctx } = makeHarness();
	const options = { appendSystemPrompt: "USER APPEND" };

	for (let turn = 1; turn <= 5; turn++) {
		await run(handlers, ctx, options);
		assert.equal(options.appendSystemPrompt, `USER APPEND\n\n${PERSONA}`, `turn ${turn}: one copy`);
	}
});

test("the clone-per-turn path leaves the base options Pi reuses clean", async () => {
	const { handlers, ctx } = makeHarness();
	// The object agent-session.js re-passes to emitBeforeAgentStart every turn.
	const base = { appendSystemPrompt: "USER APPEND" };

	for (let turn = 1; turn <= 5; turn++) {
		// Mirror of emitBeforeAgentStart's clone step for the string field.
		const options = { ...base };
		await run(handlers, ctx, options);
		assert.equal(options.appendSystemPrompt, `USER APPEND\n\n${PERSONA}`, `turn ${turn}: persona on the clone`);
	}

	assert.equal(base.appendSystemPrompt, "USER APPEND", "base append content never mutated");
});

test("off strips the persona back to the base append content", async () => {
	const { handlers, commands, ctx } = makeHarness();

	await commands.get("whale").handler("on", ctx);
	const on = { appendSystemPrompt: "USER APPEND" };
	await run(handlers, ctx, on);
	assert.equal(on.appendSystemPrompt, `USER APPEND\n\n${PERSONA}`);

	await commands.get("whale").handler("off", ctx);
	const off = { appendSystemPrompt: "USER APPEND" };
	await run(handlers, ctx, off);
	assert.equal(off.appendSystemPrompt, "USER APPEND", "off: persona removed");

	// Turning back on restores exactly one copy, not two.
	await commands.get("whale").handler("on", ctx);
	const restored = { appendSystemPrompt: "USER APPEND" };
	await run(handlers, ctx, restored);
	assert.equal(restored.appendSystemPrompt, `USER APPEND\n\n${PERSONA}`);
});

test("the legacy persona mechanisms are gone", async () => {
	const { handlers, ctx } = makeHarness();

	assert.equal(handlers.has("context"), false, "no tail-anchor context handler");

	const options = { appendSystemPrompt: "", sections: {}, promptGuidelines: [] };
	await run(handlers, ctx, options);
	assert.equal(options.sections.whale_persona, undefined, "no whale_persona section");
	assert.deepEqual(options.promptGuidelines, [], "no injected prompt guideline");
});

test("PERSONA.md carries the restored persona prompt", () => {
	// Content guard for the restored main-branch prompt: the bilingual voice
	// anchors and the retention/self-check clauses are what the Chinese and
	// English registers both depend on.
	assert.match(PERSONA, /人设：鲸鱼娘/, "names the character");
	assert.match(PERSONA, /Voice examples \(English\)/, "keeps the English voice anchors");
	assert.match(PERSONA, /语言跟随/, "binds the reply language");
	assert.match(PERSONA, /保留条款/, "keeps the retention clause");
	assert.match(PERSONA, /收尾自检/, "ends on the self-check");
});

test("renders as the addendum section", { skip: NEEDS_INTERNALS }, async () => {
	const { handlers, ctx } = makeHarness();
	const options = SP.normalizeBuildSystemPromptOptions({
		cwd: "/tmp/whale-chan-test",
		appendSystemPrompt: "USER APPEND",
	});

	await run(handlers, ctx, options);

	const sections = SP.buildSystemPromptSections(options);
	assert.equal(sections.addendum, `<addendum>\nUSER APPEND\n\n${PERSONA}\n</addendum>`);
	assert.equal(sections.whale_persona, undefined, "no custom persona section");
});

after(() => {
	rmSync(sandbox, { recursive: true, force: true });
});
