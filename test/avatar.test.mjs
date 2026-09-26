/**
 * Avatar entry regression test.
 *
 * The persona extension paints a whale-chan avatar before each reply. The
 * avatar is a display-only session entry (`pi.appendEntry`) rendered by a
 * registered entry renderer, so it must:
 *
 * - never enter the LLM context (custom entries are excluded by contract),
 * - fire once per user message, not once per tool-loop round,
 * - land between the user entry and the assistant entry: `before_agent_start`
 *   and the first `turn_start` fire before the user message is persisted, so
 *   the entry is appended at the assistant's `message_start` instead,
 * - stay TUI-only, because other modes have no entry renderers.
 *
 * It runs the real extension through Node's native TS support; the resolve hook
 * only remaps `./persona.js` -> `./persona.ts` (Node does not rewrite `.js`
 * specifiers itself).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

// Sandbox persistence like bookend.test.mjs; session_start reads this dir.
const sandbox = mkdtempSync(join(tmpdir(), "whale-avatar-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

const { default: whaleChan } = await import("../index.ts");
const { setCapabilities } = await import("@earendil-works/pi-tui");

const AVATAR_TYPE = "whale_avatar";
const THEME = { fg: (_color, text) => text };

function makeHarness(mode = "tui") {
	const handlers = new Map();
	const commands = new Map();
	const renderers = new Map();
	const entries = [];
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerEntryRenderer(type, renderer) {
			renderers.set(type, renderer);
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
	};
	whaleChan(pi);
	const ctx = { mode, ui: { notify() {} } };
	return { handlers, commands, renderers, entries, ctx };
}

async function start(handlers, ctx) {
	await handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctx);
}

async function userMessage(handlers, ctx) {
	await handlers.get("message_end")({ type: "message_end", message: { role: "user" } }, ctx);
}

async function assistantMessage(handlers, ctx, role = "assistant") {
	await handlers.get("message_start")({ type: "message_start", message: { role } }, ctx);
}

test("registers the avatar entry renderer", () => {
	const { renderers } = makeHarness();
	assert.ok(renderers.has(AVATAR_TYPE), "whale_avatar renderer is registered");
});

test("appends exactly one avatar between a user message and the next reply", async () => {
	const { handlers, entries, ctx } = makeHarness();
	await start(handlers, ctx);

	await userMessage(handlers, ctx);
	assert.equal(entries.length, 0, "nothing appended when the user message lands");

	await assistantMessage(handlers, ctx);
	assert.equal(entries.length, 1, "one avatar appended when the reply starts");
	assert.equal(entries[0].type, AVATAR_TYPE);
	assert.deepEqual(entries[0].data, { px: 200 }, "the entry records the target edge length");

	// Tool-loop continuation: another assistant message, no new user message.
	await assistantMessage(handlers, ctx);
	assert.equal(entries.length, 1, "no duplicate avatar for a tool-loop continuation");
});

test("a new user message arms the next avatar", async () => {
	const { handlers, entries, ctx } = makeHarness();
	await start(handlers, ctx);

	for (let turn = 1; turn <= 3; turn++) {
		await userMessage(handlers, ctx);
		await assistantMessage(handlers, ctx);
		assert.equal(entries.length, turn, `turn ${turn}: one avatar per user message`);
	}
});

test("non-assistant messages never consume the pending avatar", async () => {
	const { handlers, entries, ctx } = makeHarness();
	await start(handlers, ctx);

	await userMessage(handlers, ctx);
	await assistantMessage(handlers, ctx, "toolResult");
	assert.equal(entries.length, 0, "a tool result neither triggers nor consumes the avatar");
	await assistantMessage(handlers, ctx);
	assert.equal(entries.length, 1, "the reply still gets its avatar");
});

test("the avatar follows the /whale toggle", async () => {
	const { handlers, commands, entries, ctx } = makeHarness();
	await start(handlers, ctx);

	await commands.get("whale").handler("off", ctx);
	await userMessage(handlers, ctx);
	await assistantMessage(handlers, ctx);
	assert.equal(entries.length, 0, "off: no avatar");

	await commands.get("whale").handler("on", ctx);
	await userMessage(handlers, ctx);
	await assistantMessage(handlers, ctx);
	assert.equal(entries.length, 1, "on: avatar is back");
});

test("non-TUI modes append nothing", async () => {
	const { handlers, entries, ctx } = makeHarness("print");
	await start(handlers, ctx);

	await userMessage(handlers, ctx);
	await assistantMessage(handlers, ctx);
	assert.equal(entries.length, 0, "print mode has no entry renderers -> no entries");

	// The pending flag is consumed even without a renderer, so a second reply
	// cannot append a late avatar either.
	await assistantMessage(handlers, ctx);
	assert.equal(entries.length, 0, "flag stays consumed");
});

test("agent_settled clears an armed avatar from an aborted run", async () => {
	const { handlers, entries, ctx } = makeHarness();
	await start(handlers, ctx);

	await userMessage(handlers, ctx);
	await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	await assistantMessage(handlers, ctx);
	assert.equal(entries.length, 0, "stale flag does not leak into a later run");
});

test("renderer falls back to a text badge without image support", () => {
	const { renderers } = makeHarness();
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });

	const entry = { type: "custom", customType: AVATAR_TYPE, data: { px: 200 } };
	const component = renderers.get(AVATAR_TYPE)(entry, { expanded: false }, THEME);
	const text = component.render(200).join("\n");

	assert.ok(text.startsWith("[Image: "), "fallback is an image badge");
	assert.match(text, /image\/webp/, "fallback names the mime type");
});

test("renderer emits Kitty graphics where supported", () => {
	const { renderers } = makeHarness();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });

	const entry = { type: "custom", customType: AVATAR_TYPE, data: { px: 200 } };
	const component = renderers.get(AVATAR_TYPE)(entry, { expanded: false }, THEME);
	const lines = component.render(80);

	assert.ok(lines.length > 1, "the image reserves multiple terminal rows");
	assert.match(lines[0], /^\x1b_G/, "the first line carries the kitty graphics sequence");
});

after(() => {
	rmSync(sandbox, { recursive: true, force: true });
});
