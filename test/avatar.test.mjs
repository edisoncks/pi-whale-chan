/**
 * Avatar entry regression test.
 *
 * The persona extension paints a whale-chan avatar before each reply. The
 * avatar is a display-only session entry (`pi.appendEntry`) rendered by a
 * registered entry renderer, so it must:
 *
 * - never enter the LLM context (custom entries are excluded by contract),
 * - fire before every assistant message (every reply, including the ones that
 *   follow tool results), not once per user message,
 * - land after the previous entry and before the assistant entry:
 *   `before_agent_start` and the first `turn_start` fire before the user
 *   message is persisted, so the entry is appended at the assistant's
 *   `message_start` instead,
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
const { setCapabilities, resetCapabilitiesCache } = await import("@earendil-works/pi-tui");

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

async function messageStarts(handlers, ctx, role) {
	await handlers.get("message_start")({ type: "message_start", message: { role } }, ctx);
}

test("registers the avatar entry renderer", () => {
	const { renderers } = makeHarness();
	assert.ok(renderers.has(AVATAR_TYPE), "whale_avatar renderer is registered");
});

test("appends an avatar before an assistant reply", async () => {
	const { handlers, entries, ctx } = makeHarness();
	await start(handlers, ctx);

	await messageStarts(handlers, ctx, "assistant");
	assert.equal(entries.length, 1, "one avatar appended when the reply starts");
	assert.equal(entries[0].type, AVATAR_TYPE);
	assert.deepEqual(entries[0].data, { px: 200 }, "the entry records the target edge length");
});

test("every reply in a tool-heavy run gets its own avatar", async () => {
	// Regression: an earlier one-per-user-message design left the reply after
	// the tool calls — the one the user is reading — without an avatar.
	const { handlers, entries, ctx } = makeHarness();
	await start(handlers, ctx);

	// narration -> tool -> reply -> tool -> reply
	await messageStarts(handlers, ctx, "assistant");
	await messageStarts(handlers, ctx, "toolResult");
	await messageStarts(handlers, ctx, "assistant");
	await messageStarts(handlers, ctx, "toolResult");
	await messageStarts(handlers, ctx, "assistant");

	assert.equal(entries.length, 3, "three replies -> three avatars");
});

test("non-assistant messages get no avatar", async () => {
	const { handlers, entries, ctx } = makeHarness();
	await start(handlers, ctx);

	await messageStarts(handlers, ctx, "toolResult");
	assert.equal(entries.length, 0, "tool results are not replies");
});

test("the avatar follows the /whale toggle", async () => {
	const { handlers, commands, entries, ctx } = makeHarness();
	await start(handlers, ctx);

	await commands.get("whale").handler("off", ctx);
	await messageStarts(handlers, ctx, "assistant");
	assert.equal(entries.length, 0, "off: no avatar");

	await commands.get("whale").handler("on", ctx);
	await messageStarts(handlers, ctx, "assistant");
	assert.equal(entries.length, 1, "on: avatar is back");
});

test("non-TUI modes append nothing", async () => {
	const { handlers, entries, ctx } = makeHarness("print");
	await start(handlers, ctx);

	await messageStarts(handlers, ctx, "assistant");
	assert.equal(entries.length, 0, "print mode has no entry renderers -> no entries");
});

test("renderer falls back to a text badge without image support", () => {
	const { renderers } = makeHarness();
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });

	const entry = { type: "custom", customType: AVATAR_TYPE, data: { px: 200 } };
	const component = renderers.get(AVATAR_TYPE)(entry, { expanded: false }, THEME);
	const [badge] = component.render(200);

	assert.match(badge, /^ \[Image: /, "badge carries the transcript's one-column inset");
	assert.match(badge, /image\/png/, "fallback names the mime type");
});

test("renderer emits Kitty PNG graphics where supported", () => {
	const { renderers } = makeHarness();
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });

	const entry = { type: "custom", customType: AVATAR_TYPE, data: { px: 200 } };
	const component = renderers.get(AVATAR_TYPE)(entry, { expanded: false }, THEME);
	const lines = component.render(80);

	assert.match(lines[0], /^ \x1b_G/, "the image carries the transcript's one-column inset");
	assert.match(lines[0], /f=100/, "the payload is declared as PNG (the format Image transmits)");
	assert.ok(lines[0].includes("iVBORw0KGgo"), "the payload starts with the PNG signature");
	assert.ok(lines.length > 1, "the image reserves multiple terminal rows");
});

after(() => {
	// setCapabilities() writes the shared capability cache in pi-tui; drop it so
	// a later consumer in this process re-detects instead of inheriting the stub.
	resetCapabilitiesCache();
	rmSync(sandbox, { recursive: true, force: true });
});
