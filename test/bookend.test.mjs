/**
 * Bookend regression test.
 *
 * Pi's extension runner clones the base options before invoking
 * `before_agent_start`: `emitBeforeAgentStart` (dist/core/extensions/runner.js)
 * calls `normalizeBuildSystemPromptOptions` once per turn, which returns a fresh
 * object with fresh `sections` / `promptGuidelines` copies. `agent-session.js`
 * re-passes the same `_baseSystemPromptOptions` every turn, but the handler only
 * ever mutates a per-turn clone, so the array cannot accumulate across turns —
 * guard or no guard.
 *
 * The `!guidelines.includes(...)` guard in index.ts is therefore DEFENSIVE, not
 * load-bearing. This file pins BOTH the real path (base options stay clean) and
 * the defensive case (one shared object would otherwise leak, so the guard keeps
 * it at one copy). It runs the real extension through Node's native TS support;
 * the resolve hook only remaps `./persona.js` -> `./persona.ts` (Node does not
 * rewrite `.js` specifiers itself); compiled `.js` inside node_modules is left
 * untouched.
 *
 * The render assertions read Pi's internal `dist/core/system-prompt.js`, which is
 * not in the package's `exports` map. That access is OPTIONAL: if Pi reshuffles
 * `dist/`, the render-dependent tests skip with a clear reason instead of
 * hard-failing the suite on a dependency bump. The behavior and constant tests
 * (anchors, language binding) stay independent of internals and always run.
 * Set WHALE_TEST_FORCE_NO_INTERNALS=1 to exercise that skip path locally.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
const { WHALE_PERSONA, WHALE_VOICE_RULE, WHALE_TAIL_ANCHOR } = await import("../persona.ts");

// The exports map hides ./dist/core/*, so resolve the package entry first and
// load the renderer from its sibling. This lets us assert on the ACTUAL rendered
// `<rules>` section, not just the array the extension mutates.
//
// Internal access is OPTIONAL. `dist/core/system-prompt.js` is not a public
// subpath, so a Pi release could move or rename it. We probe a few likely
// locations and validate the exports; if the API is gone, SP stays null and the
// render-dependent tests skip (see NEEDS_INTERNALS) rather than crashing the
// whole file at import time. The anchor/constant tests never touch SP.
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
	console.warn(`[bookend.test] ${NEEDS_INTERNALS}`);
}

const SECTION_NAME = "whale_persona";
const CWD = "/tmp/whale-chan-test";

/** Options shaped exactly like Pi's normalized ones, not a hand-rolled literal. */
function makeOptions() {
	return SP.normalizeBuildSystemPromptOptions({ cwd: CWD });
}

function countRule(options) {
	return options.promptGuidelines.filter((rule) => rule === WHALE_VOICE_RULE).length;
}

function renderedRuleCount(options) {
	const rules = SP.buildSystemPromptSections(options).rules ?? "";
	return rules.split(WHALE_VOICE_RULE).length - 1;
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

test("real clone-per-turn path: the base options Pi reuses stay clean", { skip: NEEDS_INTERNALS }, async () => {
	const { handlers, ctx } = makeHarness();
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

	// The object agent-session.js re-passes to emitBeforeAgentStart every turn.
	const base = makeOptions();
	const baseline = base.promptGuidelines.length; // usually 0; do not hardcode

	for (let turn = 1; turn <= 5; turn++) {
		// Mirror of emitBeforeAgentStart's clone step, using the SDK's own
		// normalizer so this stays faithful rather than hand-rolled.
		const options = SP.normalizeBuildSystemPromptOptions(base);
		await handlers.get("before_agent_start")(
			{ type: "before_agent_start", systemPromptOptions: options },
			ctx,
		);
		assert.equal(options.sections[SECTION_NAME], WHALE_PERSONA, `turn ${turn}: tail persona on the clone`);
		assert.equal(countRule(options), 1, `turn ${turn}: exactly one voice rule on the clone`);
		assert.equal(renderedRuleCount(options), 1, `turn ${turn}: rendered rules carry it once`);
	}

	// Pi clones per turn, so the base object it reuses is never mutated and
	// nothing can accumulate across turns even without the guard.
	assert.equal(countRule(base), 0, "base promptGuidelines never accumulate");
	assert.equal(base.promptGuidelines.length, baseline, "base guideline array unchanged");
	assert.equal(base.sections[SECTION_NAME], undefined, "base sections never accumulate");
});

test("defensive guard: one shared object would otherwise leak, so it stays at one copy", { skip: NEEDS_INTERNALS }, async () => {
	// Hypothetical: Pi stopped cloning and handed every turn the SAME object.
	// The guard must hold — this is what it exists for.
	const { handlers, commands, ctx } = makeHarness();
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);

	const options = makeOptions();
	const baseline = options.promptGuidelines.length;
	const event = { type: "before_agent_start", systemPromptOptions: options };

	for (let turn = 1; turn <= 5; turn++) {
		await handlers.get("before_agent_start")(event, ctx);
		assert.equal(options.sections[SECTION_NAME], WHALE_PERSONA, `turn ${turn}: tail persona present`);
		assert.equal(countRule(options), 1, `turn ${turn}: exactly one voice rule in the array`);
		assert.equal(options.promptGuidelines.length, baseline + 1, `turn ${turn}: array did not accumulate`);
		assert.equal(renderedRuleCount(options), 1, `turn ${turn}: rendered rules carry it exactly once`);
	}

	// Turning off must remove BOTH the tail section and the head rule.
	await commands.get("whale").handler("off", ctx);
	await handlers.get("before_agent_start")(event, ctx);
	assert.equal(options.sections[SECTION_NAME], undefined, "off: tail persona removed");
	assert.equal(countRule(options), 0, "off: head rule removed");
	assert.equal(renderedRuleCount(options), 0, "off: gone from the rendered rules too");

	// Turning back on restores exactly one of each, not two.
	await commands.get("whale").handler("on", ctx);
	await handlers.get("before_agent_start")(event, ctx);
	assert.equal(options.sections[SECTION_NAME], WHALE_PERSONA, "on: tail persona restored");
	assert.equal(countRule(options), 1, "on: exactly one voice rule restored");
	assert.equal(options.promptGuidelines.length, baseline + 1, "on: no duplication after toggle round-trip");
	assert.equal(renderedRuleCount(options), 1, "on: rendered rules carry it exactly once");
});

test("buildRules dedupes, so extra copies cannot reach the rendered rules", { skip: NEEDS_INTERNALS }, () => {
	// Why a leak would be an in-memory array problem, not a prompt/cache
	// problem: buildRules dedupes normalized rules before rendering.
	const options = makeOptions();
	options.promptGuidelines.push(WHALE_VOICE_RULE, WHALE_VOICE_RULE, WHALE_VOICE_RULE);

	assert.equal(countRule(options), 3, "the raw array would hold duplicates");
	assert.equal(renderedRuleCount(options), 1, "rendering dedupes, so the prompt is unchanged");
});

test("the head rule is absent when a custom prompt replaces the default preamble", { skip: NEEDS_INTERNALS }, () => {
	// Known limitation, asserted so a future change cannot silently regress it:
	// promptGuidelines only render into `rules` in the default preamble branch.
	const options = SP.normalizeBuildSystemPromptOptions({ cwd: CWD, customPrompt: "custom prefix" });
	options.promptGuidelines.push(WHALE_VOICE_RULE);
	options.sections[SECTION_NAME] = WHALE_PERSONA;

	const sections = SP.buildSystemPromptSections(options);
	assert.equal(sections.rules, undefined, "custom prompt: no default preamble -> no rules section");
	assert.equal(
		sections[SECTION_NAME],
		`<${SECTION_NAME}>\n${WHALE_PERSONA}\n</${SECTION_NAME}>`,
		"custom prompt: the tail persona still renders",
	);
});

test("tail anchor: transient, and only after a tool result", async () => {
	const { handlers, commands, ctx } = makeHarness();
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
	await commands.get("whale").handler("on", ctx); // order-independent: force a known state

	// Generation is about to follow tool output: append a user-role anchor.
	const afterTool = await handlers.get("context")(
		{ type: "context", messages: [{ role: "user" }, { role: "assistant" }, { role: "toolResult" }] },
		ctx,
	);
	assert.equal(afterTool.messages.length, 4, "one anchor appended");
	assert.equal(afterTool.messages[3].role, "custom", "anchor is a custom message (-> user role)");
	assert.equal(afterTool.messages[3].content, WHALE_TAIL_ANCHOR, "anchor text is the frozen constant");
	assert.equal(afterTool.messages[0].role, "user", "existing messages are preserved, anchor only appended");

	// Last message is the user prompt: the system bookend covers this, no anchor.
	const afterUser = await handlers.get("context")({ type: "context", messages: [{ role: "user" }] }, ctx);
	assert.equal(afterUser, undefined, "no anchor when the last message is not a tool result");

	// Off: never appended.
	await commands.get("whale").handler("off", ctx);
	const offResult = await handlers.get("context")(
		{ type: "context", messages: [{ role: "toolResult" }] },
		ctx,
	);
	assert.equal(offResult, undefined, "off: no tail anchor");
});

test("anchors bind the output language (guard against English-only drift)", () => {
	// The persona body is Chinese-dominant, so an English-only meta-instruction
	// at the tail could bias non-English turns toward English — a rule-1 drift.
	// Every agent-facing constant must bind the reply to the user's language, and
	// the tail anchor carries a CJK echo so it never reads as English-only.
	for (const [name, text] of [
		["WHALE_VOICE_RULE", WHALE_VOICE_RULE],
		["WHALE_TAIL_ANCHOR", WHALE_TAIL_ANCHOR],
	]) {
		assert.match(text, /user's language|用户的语言/, `${name} binds the output language`);
	}
	assert.match(WHALE_TAIL_ANCHOR, /[\u4e00-\u9fff]/, "WHALE_TAIL_ANCHOR carries a CJK echo");
});

test("stage directions are bound to the message language too", () => {
	// Regression: an English reply that opened with a Chinese action line
	// (*尾巴一甩*). Rule 1 named "prose + interjections" but not the *…* stage
	// directions, and rule 2 asked for tail descriptions without saying which
	// language they take — so the prose localized while the wags did not.
	assert.match(WHALE_VOICE_RULE, /stage direction/i, "head rule names stage directions");
	assert.match(WHALE_TAIL_ANCHOR, /stage direction/i, "tail anchor names stage directions");
	assert.match(WHALE_PERSONA, /舞台提示/, "persona rule 1 names stage directions");
	assert.match(WHALE_PERSONA, /\*tail flick\*/, "persona shows an English stage-direction example");
});

after(() => {
	rmSync(sandbox, { recursive: true, force: true });
});
