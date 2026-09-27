/**
 * Pet strip regression test.
 *
 * The extension paints an animated whale-chan strip above the editor. That strip
 * is display-only, so these tests pin the contract that keeps it that way and
 * the frame data that keeps it honest:
 *
 * - the idle cycle mirrors `dsh-whale-pet`'s `preview` sequence and per-frame
 *   delays (irregular holds are the acting, not noise),
 * - the working cycle is the upstream ping-pong at a uniform 220 ms,
 * - every referenced asset exists as an RGBA PNG small enough for the strip,
 * - the separator reuses the editor's own border glyph and thinking-level colour,
 *   so the strip and the input box read as one frame,
 * - the text column is reserved with cursor-forward, never with spaces (spaces
 *   would repaint the image's anchor row with the terminal background),
 * - terminals without the Kitty graphics protocol get a text-only strip rather
 *   than a scrambled one,
 * - a disposed widget goes inert.
 *
 * The upstream frame data is copied, not fetched: if this extension's timing
 * ever diverges from the source it was derived from, these tests fail loudly.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

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

const {
	AVATAR_MAX_COLUMNS,
	AVATAR_MAX_ROWS,
	AVATAR_SLOT_COLUMNS,
	DIVIDER_CHAR,
	PET_CYCLES,
	RULE_CHAR,
	WhalePetWidget,
	avatarInset,
	buildProgressBar,
	fitCells,
	formatTokens,
	framePath,
	loadFrame,
	resolveProgressColor,
	stateColumns,
	textColumn,
} = await import("../pet.ts");
const { resetCapabilitiesCache, setCapabilities } = await import("@earendil-works/pi-tui");

/**
 * Alpha bounding box of an 8-bit RGBA, non-interlaced PNG.
 *
 * Centring is an *asset* property: the widget centres whatever the PNG header
 * says, so a frame whose artwork sits off to one side renders off to one side.
 * An earlier revision shipped exactly that bug and only a human eye caught it,
 * so this decodes the alpha channel instead of trusting a glance.
 */
function alphaBounds(png) {
	const width = png.readUInt32BE(16);
	const height = png.readUInt32BE(20);
	assert.equal(png.readUInt8(24), 8, "8-bit channels");
	assert.equal(png.readUInt8(25), 6, "truecolour with alpha");
	assert.equal(png.readUInt8(28), 0, "not interlaced");

	const parts = [];
	for (let offset = 8; offset < png.length; ) {
		const length = png.readUInt32BE(offset);
		const type = png.toString("ascii", offset + 4, offset + 8);
		if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
		if (type === "IEND") break;
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(parts));

	const stride = width * 4;
	const previous = Buffer.alloc(stride);
	const current = Buffer.alloc(stride);
	const bounds = { minX: width, maxX: -1, minY: height, maxY: -1 };
	let cursor = 0;
	for (let y = 0; y < height; y++) {
		const filter = raw[cursor];
		cursor += 1;
		for (let i = 0; i < stride; i++) {
			const value = raw[cursor + i];
			const left = i >= 4 ? current[i - 4] : 0;
			const up = previous[i];
			const upLeft = i >= 4 ? previous[i - 4] : 0;
			let restored;
			if (filter === 0) restored = value;
			else if (filter === 1) restored = (value + left) & 0xff;
			else if (filter === 2) restored = (value + up) & 0xff;
			else if (filter === 3) restored = (value + ((left + up) >> 1)) & 0xff;
			else {
				const p = left + up - upLeft;
				const pa = Math.abs(p - left);
				const pb = Math.abs(p - up);
				const pc = Math.abs(p - upLeft);
				const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
				restored = (value + predictor) & 0xff;
			}
			current[i] = restored;
		}
		for (let x = 0; x < width; x++) {
			if (current[x * 4 + 3] > 16) {
				if (x < bounds.minX) bounds.minX = x;
				if (x > bounds.maxX) bounds.maxX = x;
				if (y < bounds.minY) bounds.minY = y;
				if (y > bounds.maxY) bounds.maxY = y;
			}
		}
		current.copy(previous);
		cursor += stride;
	}
	return bounds;
}

/** A theme surface shaped like Pi's, with the thinking colour rendered inline. */
const THEME = {
	fg: (_color, text) => text,
	bold: (text) => text,
	getThinkingBorderColor: () => (text) => text,
};

const TUI = { requestRender() {} };

function makeTui() {
	let renders = 0;
	return { tui: { requestRender() { renders += 1; } }, renders: () => renders };
}

/**
 * A fully-populated stats snapshot, so widget tests exercise the four-line
 * panel without each one spelling out every field. `stats: undefined` in a
 * view opts a case out.
 */
const DEFAULT_STATS = {
	reasoning: true,
	contextWindow: 1_000_000,
	contextTokens: 14_000,
	contextPercent: 1.4,
	inputTokens: 10_000,
	outputTokens: 4_600,
	cacheHitRate: 99.8,
	cost: 0.003,
	cwd: join(process.env.HOME ?? "/home/test", "repos", "pi-emote"),
};

function makeWidget(view, tui = TUI, theme = THEME) {
	return new WhalePetWidget(tui, theme, { thinkingLevel: "off", stats: DEFAULT_STATS, ...view });
}

/**
 * Column at which a rendered strip row prints the divider: the leading spaces
 * (the frame's centring inset) plus the cursor-forward that follows them.
 */
function dividerColumn(line) {
	const leading = /^ */.exec(line)[0].length;
	const forward = Number(/\x1b\[(\d+)C/.exec(line)?.[1] ?? 0);
	return leading + forward;
}

function kitty() {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
}

test("idle cycle mirrors dsh-whale-pet's preview sequence and timing", () => {
	assert.deepEqual(
		PET_CYCLES.idle.map((frame) => frame.asset),
		["idle-awake", "idle-blink", "idle-awake", "idle-drowsy", "idle-sleep", "idle-startle", "idle-awake"],
		"frame order is copied verbatim from idle-animation.json `preview`",
	);
	assert.deepEqual(
		PET_CYCLES.idle.map((frame) => frame.durationMs),
		[1400, 160, 900, 650, 1500, 420, 800],
		"the irregular holds are the breathing/sleep beat and must not be flattened",
	);
});

test("working cycle is the upstream ping-pong at a uniform pace", () => {
	const assets = PET_CYCLES.working.map((frame) => frame.asset);
	assert.equal(assets.length, 12, "WORKING_FRAMES has 12 entries");
	assert.deepEqual(
		assets.slice(0, 7),
		["working-0", "working-0-1", "working-1", "working-1-2", "working-2", "working-2-3", "working-3"],
		"outbound half of the cycle",
	);
	assert.deepEqual(
		assets.slice(7),
		["working-2-3", "working-2", "working-1-2", "working-1", "working-0-1"],
		"the return half replays the in-betweens, so the loop never snaps",
	);
	assert.ok(
		PET_CYCLES.working.every((frame) => frame.durationMs === 220),
		"WORKING_FRAME_DELAY_MS is 220",
	);
});

test("every referenced frame is an RGBA PNG inside the avatar box", () => {
	const seen = new Set();
	for (const cycle of Object.values(PET_CYCLES)) {
		for (const { asset } of cycle) {
			if (seen.has(asset)) continue;
			seen.add(asset);
			const path = framePath(asset);
			assert.ok(existsSync(path), `${asset}.png ships with the extension`);
			const png = readFileSync(path);
			assert.equal(png.readUInt8(25), 6, `${asset} keeps an alpha channel (no baked-in background)`);
			const width = png.readUInt32BE(16);
			const height = png.readUInt32BE(20);
			// A uniform canvas is what keeps every pose in the same cell box, so the
			// two states cannot end up centred a column apart.
			assert.equal(width, 96, `${asset} sits on the normalised 96px canvas`);
			assert.equal(height, 96, `${asset} sits on the normalised 96px canvas`);
		}
	}
	assert.equal(seen.size, 12, "twelve distinct frames back the two cycles");
});

test("every frame's artwork is horizontally centred in its canvas", () => {
	for (const cycle of Object.values(PET_CYCLES)) {
		for (const { asset } of cycle) {
			const bounds = alphaBounds(readFileSync(framePath(asset)));
			const left = bounds.minX;
			const right = 95 - bounds.maxX;
			// The tolerance absorbs pose variation (the sleep pose slumps); the bug
			// this pins left a 5px gap, and the widget can only centre the canvas.
			assert.ok(
				Math.abs(left - right) <= 3,
				`${asset} artwork is centred (left ${left}, right ${right})`,
			);
		}
	}
});

test("fitCells keeps a frame inside the strip box", () => {
	// Frames are normalised to a square canvas; the maths still has to hold for a
	// portrait one, because a future asset could reintroduce it.
	assert.deepEqual(fitCells(96, 96, 9, 18), { columns: 8, rows: 4 });
	assert.deepEqual(fitCells(77, 96, 9, 18), { columns: 7, rows: 4 });
});

test("the reserved text column is the slot plus the divider", () => {
	assert.equal(
		AVATAR_SLOT_COLUMNS,
		AVATAR_MAX_COLUMNS,
		"the slot is the frame box, with no extra padding",
	);
	assert.equal(textColumn(), AVATAR_SLOT_COLUMNS + 2, "divider + one blank column");
});

test("a narrower frame is centred inside the fixed slot", () => {
	assert.equal(avatarInset(AVATAR_SLOT_COLUMNS), 0, "a full-width frame needs no inset");
	assert.equal(avatarInset(AVATAR_SLOT_COLUMNS - 2), 1, "a two-column-narrower frame insets by one");
	assert.equal(avatarInset(AVATAR_SLOT_COLUMNS - 1), 0, "an odd gap keeps the left edge");
	// The inset plus the cursor-forward that follows it must still land on the
	// slot column, and the frame must never reach across the divider.
	for (let columns = 1; columns <= AVATAR_SLOT_COLUMNS; columns++) {
		const inset = avatarInset(columns);
		assert.equal(inset + (AVATAR_SLOT_COLUMNS - inset), AVATAR_SLOT_COLUMNS, `columns=${columns}: divider column`);
		assert.ok(inset + columns <= AVATAR_SLOT_COLUMNS, `columns=${columns}: frame stays short of the divider`);
	}
});

test("both poses sit flush to the slot with no centring inset", () => {
	kitty();
	assert.equal(stateColumns("idle"), 8, "the normalised canvas fills the frame box");
	assert.equal(stateColumns("working"), 8, "and so does the other pose");

	const idle = makeWidget({ state: "idle", model: "m" });
	const idleRow = idle.render(40)[1];
	idle.dispose();
	const working = makeWidget({ state: "working", model: "m" });
	const workingRow = working.render(40)[1];
	working.dispose();

	assert.equal(/^ */.exec(idleRow)[0].length, 0, "idle starts at the slot edge");
	assert.equal(/^ */.exec(workingRow)[0].length, 0, "the widest pose starts at the slot edge too");
});

test("the vertical divider is a straight line across the whole strip", () => {
	kitty();
	for (const state of ["idle", "working"]) {
		const widget = makeWidget({ state, model: "m" });
		const lines = widget.render(40);
		widget.dispose();

		const rows = lines.slice(1);
		assert.equal(rows.length, AVATAR_MAX_ROWS, `${state}: one row per avatar row`);
		assert.ok(
			rows.every((line) => line.includes(DIVIDER_CHAR)),
			`${state}: every strip row draws the divider, so it spans the avatar's full height`,
		);
		assert.deepEqual(
			rows.map(dividerColumn),
			Array(AVATAR_MAX_ROWS).fill(AVATAR_SLOT_COLUMNS),
			`${state}: the divider lands on the same column in every row, so it does not zag`,
		);
		// The divider must be drawn after the image escape, never over it.
		assert.ok(
			rows[0].indexOf(DIVIDER_CHAR) > rows[0].indexOf("\x1b_G"),
			`${state}: the divider lands past the image`,
		);
	}
});

test("the text-only strip draws no divider", () => {
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
	const widget = makeWidget({ state: "idle", model: "m" });
	const lines = widget.render(40);
	widget.dispose();
	assert.ok(!lines.join("\n").includes(DIVIDER_CHAR), "no divider without an avatar to divide from");
});

test("the separator reuses the editor's border glyph and colour", () => {
	kitty();
	const levels = [];
	const theme = {
		...THEME,
		getThinkingBorderColor: (level) => {
			levels.push(level);
			return (text) => `<${level}>${text}</${level}>`;
		},
	};
	const widget = makeWidget({ state: "idle", model: "m", thinkingLevel: "high" }, TUI, theme);

	assert.equal(
		widget.render(20)[0],
		`<high>${RULE_CHAR.repeat(20)}</high>`,
		"a full-width rule in the editor's thinking-level colour",
	);
	assert.ok(
		levels.length >= 1 && levels.every((level) => level === "high"),
		"every border-colour lookup follows the current level",
	);

	// The editor recolours its border on every thinking-level change; the strip
	// has to follow or the two rules visibly disagree.
	widget.update({ thinkingLevel: "off" });
	assert.equal(widget.render(20)[0], `<off>${RULE_CHAR.repeat(20)}</off>`);
	widget.dispose();
});

test("widget composes the avatar and status side by side with cursor-forward", () => {
	kitty();
	const widget = makeWidget({ state: "idle", model: "deepseek-v4.1-flash" });
	const lines = widget.render(80);
	widget.dispose();

	assert.equal(lines.length, AVATAR_MAX_ROWS + 1, "separator plus the avatar's rows");
	const graphics = lines[1];
	assert.match(graphics, /f=100/, "the frame is declared as PNG, the format Image transmits");
	assert.match(graphics, /\x1b_G/, "the frame is sent as a Kitty graphics sequence");
	assert.equal(dividerColumn(graphics), AVATAR_SLOT_COLUMNS, "the divider lands on the slot column");
	assert.match(graphics, /\x1b\[\d+C/, "the divider column is reached with cursor-forward, which never paints");
	assert.ok(graphics.includes(DIVIDER_CHAR), "a vertical divider separates the avatar from the status");
	const text = lines.join("\n");
	assert.match(text, /deepseek-v4\.1-flash/, "the model name is on the strip");
	assert.match(text, /deepseek-v4\.1-flash • off • 1\.0M/, "model, level, and window share line 1");
	assert.match(text, /⏵▕/, "the context progress bar is drawn");
	assert.match(text, /⇞99\.8%/, "the cache hit rate is shown");
});

test("a state change restarts the cycle at frame 0 of the new state", () => {
	kitty();
	const widget = makeWidget({ state: "idle", model: "m" });
	widget.update({ state: "working" });
	const lines = widget.render(80);
	widget.dispose();

	// Kitty transmits in 4096-char chunks separated by escape sequences, so the
	// payload is never contiguous. Compare a prefix that fits inside one chunk.
	const working0 = (loadFrame("working-0") ?? "").slice(0, 512);
	const idleAwake = (loadFrame("idle-awake") ?? "").slice(0, 512);
	assert.ok(working0.length > 0, "the working-0 asset loads");
	assert.ok(lines[1]?.includes(working0), "renders working-0, not a leftover idle frame");
	assert.ok(!lines[1]?.includes(idleAwake), "the previous state's frame is gone");
	assert.match(lines.join("\n"), /⇞/, "the stats panel survives a state change");
});

test("a state update that changes nothing does not restart the cycle", () => {
	kitty();
	const { tui, renders } = makeTui();
	const widget = makeWidget({ state: "idle", model: "m" }, tui);
	const before = renders();
	widget.update({ state: "idle", model: "m", thinkingLevel: "off" });
	assert.equal(renders(), before, "an identical update is a no-op");
	widget.dispose();
});

test("non-Kitty terminals get a text-only strip instead of a scrambled image", () => {
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
	const widget = makeWidget({ state: "idle", model: "m" });
	const lines = widget.render(80);
	widget.dispose();

	assert.equal(lines.length, AVATAR_MAX_ROWS + 1, "separator plus the four info lines, no avatar rows");
	assert.doesNotMatch(lines.join("\n"), /\x1b_G/, "no graphics escape is emitted");
	assert.match(lines.join("\n"), /m • off • 1\.0M/, "the model line is the fallback");
	assert.match(lines.join("\n"), /⏵▕/, "the text-only strip still shows the stats panel");
});

test("a long model label is clipped to the strip width, not wrapped", () => {
	kitty();
	const widget = makeWidget({ state: "idle", model: "x".repeat(200) });
	const lines = widget.render(40);
	widget.dispose();

	assert.equal(lines.length, AVATAR_MAX_ROWS + 1, "clipping must not add rows");
	assert.ok(!lines.join("\n").includes("x".repeat(100)), "the label is clipped");
});

test("a disposed widget goes inert", () => {
	kitty();
	const { tui, renders } = makeTui();
	const widget = makeWidget({ state: "idle", model: "m" }, tui);
	widget.dispose();
	const before = renders();
	widget.update({ state: "working" });
	assert.equal(renders(), before, "a disposed widget never asks for another render");
});

test("formatTokens compacts large counts", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_000), "1.0K");
	assert.equal(formatTokens(12_345), "12K");
	assert.equal(formatTokens(999_499), "999K");
	assert.equal(formatTokens(999_500), "1.0M", "a rounded 1000K promotes to the M unit");
	assert.equal(formatTokens(999_999), "1.0M");
	assert.equal(formatTokens(1_000_000), "1.0M");
});

test("the context bar is empty at zero and filled past the minimum", () => {
	const empty = buildProgressBar({ ...DEFAULT_STATS, contextPercent: 0, contextTokens: null });
	assert.match(empty, /^⏵▕ {20}▏ \? \(0\.0%\)$/, "an empty context draws an empty bar");
	const half = buildProgressBar({ ...DEFAULT_STATS, contextPercent: 50, cacheHitRate: 0 });
	assert.match(half, /█/, "a half-full context shows blocks");
	assert.match(half, /50\.0%/);
});

test("progress colour prioritises a cold cache, then a nearly-full context", () => {
	assert.equal(resolveProgressColor(10, 20), "error", "a cold cache is the alarm");
	assert.equal(resolveProgressColor(80, 90), "warning", "a nearly-full context outranks cache");
	assert.equal(resolveProgressColor(10, 90), "success", "a healthy cache is good news");
	assert.equal(resolveProgressColor(10, 0), "text", "a fresh session stays neutral");
});

test("the info panel renders the four stat lines", () => {
	kitty();
	const widget = makeWidget({ state: "idle", model: "deepseek-v4.1-flash" });
	const text = widget.render(80).join("\n");
	widget.dispose();
	assert.match(text, /deepseek-v4\.1-flash • off • 1\.0M/, "model, level, and window");
	assert.match(text, /⏵▕/, "a progress bar");
	assert.match(text, /↑10K ↓4\.6K ⇞99\.8% \$0\.003/, "token and cost totals");
	assert.match(text, /~\/repos\/pi-emote/, "the cwd, home-abbreviated");
});

test("without stats only the model line is drawn", () => {
	kitty();
	const widget = makeWidget({ state: "idle", model: "m", stats: undefined });
	const lines = widget.render(80);
	widget.dispose();
	assert.equal(lines.length, AVATAR_MAX_ROWS + 1, "the avatar still reserves its rows");
	assert.match(lines.join("\n"), /m/);
	assert.doesNotMatch(lines.join("\n"), /⏵▕/, "no bar without stats");
});

// --- extension wiring -------------------------------------------------------
// The frame tables above are unit-tested through the widget. These run the real
// extension so mount/unmount and the lifecycle mapping are covered too.

// The wiring tests run the real extension. `session_start` reads the agent dir,
// so sandbox persistence exactly like the other test files do.
const sandbox = mkdtempSync(join(tmpdir(), "whale-pet-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
const { default: whaleChan, createUsageAccumulator, accumulateUsage } = await import("../index.ts");
const STATE_PATH = join(sandbox, "whale-chan.json");

function makeExtensionHarness() {
	// Start every case from defaults: one case writes a preference to disk, and
	// an order-dependent suite is a trap for whoever adds the next test.
	rmSync(STATE_PATH, { force: true });
	const handlers = new Map();
	const commands = new Map();
	const widgets = new Map();
	const pi = {
		on(event, handler) {
			handlers.set(event, handler);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerEntryRenderer() {},
		appendEntry() {},
	};
	whaleChan(pi);
	const ctx = {
		mode: "tui",
		model: { id: "m", name: "M" },
		thinkingLevel: "off",
		ui: {
			notify() {},
			setWidget(key, content) {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, content);
			},
		},
	};
	return { handlers, commands, widgets, ctx };
}

function mount(widgets, theme = THEME) {
	const factory = widgets.get("whale_pet");
	assert.ok(factory !== undefined, "the strip is mounted");
	return factory(TUI, theme);
}

test("the strip mounts on session_start and follows the agent lifecycle", async () => {
	kitty();
	const { handlers, widgets, ctx } = makeExtensionHarness();
	await handlers.get("session_start")({ type: "session_start" }, ctx);

	const widget = mount(widgets);
	assert.match(widget.render(80).join("\n"), /M/, "the model name is on the strip");
	assert.match(widget.render(80).join("\n"), /⏵▕/, "the stats panel is drawn");

	await handlers.get("agent_start")({ type: "agent_start" }, ctx);
	assert.ok(
		(widget.render(80)[1] ?? "").includes((loadFrame("working-0") ?? "").slice(0, 512)),
		"a run puts the pet to work",
	);

	await handlers.get("agent_settled")({ type: "agent_settled" }, ctx);
	assert.ok(
		(widget.render(80)[1] ?? "").includes((loadFrame("idle-awake") ?? "").slice(0, 512)),
		"settling puts the pet back to rest",
	);

	await handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
	widget.dispose();
});

test("a thinking-level change recolours the separator through the real extension", async () => {
	kitty();
	const { handlers, widgets, ctx } = makeExtensionHarness();
	await handlers.get("session_start")({ type: "session_start" }, ctx);

	const levels = [];
	const theme = {
		...THEME,
		getThinkingBorderColor: (level) => {
			levels.push(level);
			return (text) => `<${level}>${text}</${level}>`;
		},
	};
	const widget = mount(widgets, theme);
	await handlers.get("thinking_level_select")(
		{ type: "thinking_level_select", level: "high", previousLevel: "off" },
		ctx,
	);
	assert.equal(
		widget.render(20)[0],
		`<high>${RULE_CHAR.repeat(20)}</high>`,
		"the new level reaches the separator colour",
	);
	widget.dispose();
});

test("/whale pet off unmounts the strip and pet on brings it back", async () => {
	kitty();
	const { handlers, commands, widgets, ctx } = makeExtensionHarness();
	await handlers.get("session_start")({ type: "session_start" }, ctx);
	assert.ok(widgets.has("whale_pet"), "the strip starts mounted (pet defaults to on)");

	await commands.get("whale").handler("pet off", ctx);
	assert.ok(!widgets.has("whale_pet"), "off unmounts the strip");
	assert.equal(
		JSON.parse(readFileSync(STATE_PATH, "utf8")).pet,
		false,
		"the preference is persisted",
	);

	await commands.get("whale").handler("pet on", ctx);
	assert.ok(widgets.has("whale_pet"), "on remounts the strip");
});

test("the persona toggle leaves the pet strip alone", async () => {
	kitty();
	const { handlers, commands, widgets, ctx } = makeExtensionHarness();
	await handlers.get("session_start")({ type: "session_start" }, ctx);

	await commands.get("whale").handler("off", ctx);
	assert.ok(widgets.has("whale_pet"), "the two switches are independent");
	assert.equal(JSON.parse(readFileSync(STATE_PATH, "utf8")).pet, true, "persona off keeps pet on");
});

test("a disabled pet preference never mounts the strip", async () => {
	kitty();
	const { handlers, widgets, commands, ctx } = makeExtensionHarness();
	await commands.get("whale").handler("pet off", ctx);
	await handlers.get("session_start")({ type: "session_start" }, ctx);
	assert.ok(!widgets.has("whale_pet"), "the persisted preference is honoured on the next session");
});

test("usage totals accumulate incrementally and rebuild on a session change", () => {
	const assistant = (input, output, cost, cacheRead = 0, cacheWrite = 0) => ({
		type: "message",
		message: { role: "assistant", usage: { input, output, cost: { total: cost }, cacheRead, cacheWrite } },
	});
	const user = { type: "message", message: { role: "user" } };

	let entries = [assistant(100, 20, 0.001, 50, 10), user, assistant(200, 40, 0.002, 150, 20)];
	const manager = { getEntries: () => entries };
	const acc = createUsageAccumulator();

	let totals = accumulateUsage(acc, manager);
	assert.equal(totals.inputTokens, 300, "the first call folds the whole session");
	assert.equal(totals.outputTokens, 60);
	assert.equal(totals.cost, 0.003);
	assert.equal(totals.latestCacheRead, 150, "latest reflects the newest assistant message");

	// No growth: the running total must not be folded twice.
	totals = accumulateUsage(acc, manager);
	assert.equal(totals.inputTokens, 300, "an unchanged session is not re-folded");
	assert.equal(acc.consumed, 3, "consumed tracks the entry count");

	// Growth resumes from the tail, not from the start.
	entries = [...entries, assistant(400, 80, 0.004, 300, 40)];
	totals = accumulateUsage(acc, manager);
	assert.equal(totals.inputTokens, 700, "only the appended entry is added");
	assert.equal(totals.outputTokens, 140);
	assert.equal(totals.cost, 0.007);
	assert.equal(totals.latestCacheRead, 300);

	// A different manager (a session switch) must rebuild, never inherit.
	const other = { getEntries: () => [assistant(7, 8, 0.009, 0, 0)] };
	totals = accumulateUsage(acc, other);
	assert.equal(totals.inputTokens, 7, "a session switch does not inherit stale totals");
	assert.equal(totals.outputTokens, 8);

	// A shrink on a fresh manager also rebuilds rather than resuming past the end.
	const shrunk = { getEntries: () => [assistant(1, 2, 0)] };
	assert.equal(accumulateUsage(acc, shrunk).inputTokens, 1, "a shrink rebuilds from scratch");
});

after(() => {
	// setCapabilities() writes pi-tui's shared capability cache; drop it so a
	// later consumer in this process re-detects instead of inheriting the stub.
	resetCapabilitiesCache();
	rmSync(sandbox, { recursive: true, force: true });
});
