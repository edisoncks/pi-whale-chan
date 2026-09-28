/**
 * Whale-chan pet — an animated avatar plus a model/status strip that Pi draws
 * above the editor as a widget. The extension replaces Pi's built-in footer with
 * an empty footer component, so the strip owns the status surface without
 * duplicating it below.
 *
 * Display-only by construction: this renders inside Pi's widget container and
 * never calls `sendMessage`/`appendEntry`, so it cannot enter the LLM context,
 * change the system prompt, or invalidate a cached prefix.
 *
 * Artwork is derived from `dsh-whale-pet` by Er1c0v0 (CC-BY-4.0). The frame
 * order and per-frame timing below are copied verbatim from that project's
 * `src/client/idle-animation.json` and `src/client/assets.ts`; see
 * ASSET_ATTRIBUTION.md for the license and the list of modifications.
 *
 * ## Why the layout is hand-composed instead of using `HStack`
 *
 * `Image.render()` returns the Kitty/iTerm2 escape sequence on one line and
 * blank lines for the remaining rows. A stripped escape sequence has an
 * *visible width of zero*, so `HStack` believes the avatar is zero cells wide
 * and would place the status text on top of the artwork.
 *
 * Two consequences drive the code below:
 *
 * 1. The avatar's cell width is computed here (`fitCells`, mirroring pi-tui's
 *    unexported `calculateImageCellSize`) and the text column is reserved by
 *    hand.
 * 2. The column is reserved with a CSI cursor-forward (`ESC[nC`) rather than
 *    spaces. Cursor-forward moves the cursor without painting, so it can never
 *    overwrite an image cell. Printing spaces would repaint the avatar's anchor
 *    row with the terminal background.
 *
 * iTerm2 needs no such care because pi-tui anchors its inline images on the
 * *last* row (it moves the cursor up and draws), which would paint over any
 * text already emitted on the preceding rows. Rather than ship a scrambled
 * strip, this widget degrades to a text-only status line unless the terminal
 * speaks the Kitty graphics protocol.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	allocateImageId,
	getCapabilities,
	getCellDimensions,
	getPngDimensions,
	Image,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

/**
 * The slice of Pi's `Theme` this widget needs. Declaring it structurally keeps
 * this module free of the coding-agent's internal theme module path, while a
 * real `Theme` still satisfies it (its `ThemeColor` union is wider, and a wider
 * parameter type is assignable to a narrower one).
 */
export interface PetTheme {
	fg(color: "accent" | "muted" | "dim" | "text" | "success" | "warning" | "error", text: string): string;
	bold(text: string): string;
	/**
	 * The separator must match the editor's border, and the editor derives that
	 * border from the thinking level, so the widget needs the same mapping.
	 */
	getThinkingBorderColor(level: PetThinkingLevel): (text: string) => string;
}

/** Mirrors `ThinkingLevel` from pi-agent-core (the editor border keys off it). */
export type PetThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * pi-tui's editor draws its border as `"─".repeat(width)`; the strip's
 * separator has to use the same glyph or the two lines read as different rules.
 */
export const RULE_CHAR = "─";

export type PetState = "idle" | "working";

export interface PetFrame {
	/** Basename of the PNG in `assets/whale-pet/`, without the extension. */
	readonly asset: string;
	readonly durationMs: number;
}

export interface PetViewModel {
	readonly state: PetState;
	/** Human-readable model label shown on the strip. */
	readonly model: string;
	/** Drives the separator colour so it tracks the editor's border. */
	readonly thinkingLevel: PetThinkingLevel;
	/** Session stats for the status panel; absent before the host wires them up. */
	readonly stats?: PetStats;
}

/**
 * Snapshot of the session stats the status panel renders: the same data Pi's
 * footer carries, regrouped into identity / gauge / meter / location.
 */
export interface PetStats {
	/** Whether the model reasons; controls the thinking-level suffix. */
	readonly reasoning: boolean;
	readonly contextWindow: number;
	/** Estimated context tokens, or null when unknown (e.g. post-compaction). */
	readonly contextTokens: number | null;
	readonly contextPercent: number | null;
	readonly inputTokens: number;
	readonly outputTokens: number;
	/** Cumulative cache-read tokens, shown as `R…` like Pi's footer. */
	readonly cacheRead: number;
	/** Cumulative cache-write tokens, shown as `W…` like Pi's footer. */
	readonly cacheWrite: number;
	/** Cache hit rate of the latest prompt, 0-100, or null when unmeasured. */
	readonly cacheHitRate: number | null;
	readonly cost: number;
	readonly cwd: string;
	/** Custom session name, shown after the cwd like Pi's footer. */
	readonly sessionName: string | null;
	/** Provider display name (e.g. "OpenCode Go"), prefixed when >1 is available. */
	readonly provider: string;
}

/**
 * The slice of Pi's `ReadonlyFooterDataProvider` this widget reads. Declared
 * structurally for the same reason as `PetTheme`: it keeps the module free of
 * the coding-agent's internal module path while a real provider still
 * satisfies it. These fields are the data a footer owns and an extension
 * cannot get from `ctx` alone (git branch and `ui.setStatus` entries).
 */
export interface PetFooterData {
	getGitBranch(): string | null;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
	onBranchChange(callback: () => void): () => void;
}

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets", "whale-pet");

/**
 * Idle cycle: the `preview` sequence and delays from `idle-animation.json`.
 * The delays are irregular on purpose — the 1400/900/1500 ms holds are the
 * breathing and sleep beat. Flattening them turns the character into a twitch.
 * `awake` legitimately appears three times; it is one asset, not a duplicate
 * file.
 */
const IDLE_CYCLE: readonly PetFrame[] = [
	{ asset: "idle-awake", durationMs: 1400 },
	{ asset: "idle-blink", durationMs: 160 },
	{ asset: "idle-awake", durationMs: 900 },
	{ asset: "idle-drowsy", durationMs: 650 },
	{ asset: "idle-sleep", durationMs: 1500 },
	{ asset: "idle-startle", durationMs: 420 },
	{ asset: "idle-awake", durationMs: 800 },
];

/**
 * Working cycle: `WORKING_FRAMES` from `assets.ts`, a ping-pong (0→3, 3→0) so
 * the loop never snaps from the last pose back to the first. Uniform 220 ms.
 */
const WORKING_ASSETS = [
	"working-0",
	"working-0-1",
	"working-1",
	"working-1-2",
	"working-2",
	"working-2-3",
	"working-3",
	"working-2-3",
	"working-2",
	"working-1-2",
	"working-1",
	"working-0-1",
] as const;

const WORKING_CYCLE: readonly PetFrame[] = WORKING_ASSETS.map((asset) => ({ asset, durationMs: 220 }));

/** Frame tables, exported so tests can pin them without touching the widget. */
export const PET_CYCLES: Readonly<Record<PetState, readonly PetFrame[]>> = {
	idle: IDLE_CYCLE,
	working: WORKING_CYCLE,
};

/**
 * Avatar box in terminal cells. Deliberately small: this is a status strip, not
 * a billboard. Every frame is normalised to a square 96×96 canvas, so both poses
 * fill the same 8×4 box and their artwork lands in the same place.
 */
export const AVATAR_MAX_COLUMNS = 8;
export const AVATAR_MAX_ROWS = 4;

/**
 * Vertical divider between the avatar and the status text, mirroring the way the
 * editor's horizontal border separates the strip from the input box.
 */
export const DIVIDER_CHAR = "│";

/** Columns between the avatar's last cell and the status text: divider + blank. */
const DIVIDER_COLUMNS = 2;

/**
 * First two bytes of a Kitty graphics escape. pi-tui's own (unexported)
 * `isImageLine` keys off this prefix to recognise a line that carries an image;
 * the widget re-checks it to confirm `Image.render` actually emitted a frame,
 * rather than trusting the blank tail that follows the escape.
 */
const KITTY_ESCAPE_PREFIX = "\x1b_G";

const frameCache = new Map<string, string | null>();

/** Absolute path of a frame asset; exported for tests. */
export function framePath(asset: string): string {
	return join(ASSET_DIR, `${asset}.png`);
}

/**
 * Read one frame as base64 PNG, cached for the process. A missing asset yields
 * `null` and the caller falls back to text, so a packaging mistake degrades the
 * strip instead of crashing a turn.
 */
export function loadFrame(asset: string): string | null {
	const cached = frameCache.get(asset);
	if (cached !== undefined) return cached;
	let data: string | null;
	try {
		data = readFileSync(framePath(asset)).toString("base64");
	} catch {
		data = null;
	}
	frameCache.set(asset, data);
	return data;
}

/**
 * Mirror of pi-tui's unexported `calculateImageCellSize` (terminal-image.ts).
 * It is duplicated rather than reimplemented approximately so the reserved text
 * column matches the cells the terminal actually paints.
 */
export function fitCells(
	widthPx: number,
	heightPx: number,
	cellWidthPx: number,
	cellHeightPx: number,
): { columns: number; rows: number } {
	const widthScale = (AVATAR_MAX_COLUMNS * cellWidthPx) / Math.max(1, widthPx);
	const heightScale = (AVATAR_MAX_ROWS * cellHeightPx) / Math.max(1, heightPx);
	const scale = Math.min(widthScale, heightScale);
	const columns = Math.ceil((Math.max(1, widthPx) * scale) / cellWidthPx);
	const rows = Math.ceil((Math.max(1, heightPx) * scale) / cellHeightPx);
	return {
		columns: Math.max(1, Math.min(AVATAR_MAX_COLUMNS, columns)),
		rows: Math.max(1, Math.min(AVATAR_MAX_ROWS, rows)),
	};
}

/**
 * Columns reserved for the avatar. Equal to the frame box: the slot adds no
 * padding of its own, so the strip stays tight to the artwork. The frame keeps
 * whatever transparent margin its own PNG carries; the layout adds none.
 */
export const AVATAR_SLOT_COLUMNS = AVATAR_MAX_COLUMNS;

/**
 * Columns of centring inset placed before a frame of `columns` cells inside the
 * fixed slot. Every shipped frame is normalised to the full slot width, so this
 * is zero in practice; a narrower future pose degrades to a centred one instead
 * of a left-shifted one.
 */
export function avatarInset(columns: number): number {
	return Math.max(0, Math.floor((AVATAR_SLOT_COLUMNS - columns) / 2));
}

const stateColumnCache = new Map<PetState, number>();

/**
 * Displayed column count of one state's frames. Every frame in a state shares a
 * canvas, so the first frame speaks for the cycle.
 */
export function stateColumns(state: PetState): number {
	const cached = stateColumnCache.get(state);
	if (cached !== undefined) return cached;
	const cell = getCellDimensions();
	const frame = PET_CYCLES[state][0];
	const data = frame === undefined ? null : loadFrame(frame.asset);
	const dims = data === null ? null : getPngDimensions(data);
	// A missing asset draws no avatar at all, so this placeholder never shows.
	const columns =
		dims === null
			? AVATAR_MAX_COLUMNS
			: fitCells(dims.widthPx, dims.heightPx, cell.widthPx, cell.heightPx).columns;
	stateColumnCache.set(state, columns);
	return columns;
}

/**
 * First column of the status text: the slot, the divider, one blank column. The
 * divider sits at `AVATAR_SLOT_COLUMNS` itself, so it does not move between
 * states even though the poses differ in width.
 */
export function textColumn(): number {
	return AVATAR_SLOT_COLUMNS + DIVIDER_COLUMNS;
}

/** Compact token counts: 1_000_000 → "1.0M", 12_345 → "12K", 999 → "999". */
export function formatTokens(count: number): string {
	// 999_500 rounds to 1000K at integer precision, so promote to the M unit
	// instead of printing "1000K".
	if (count >= 999_500) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 10_000) return `${Math.round(count / 1000)}K`;
	if (count >= 1_000) return `${(count / 1000).toFixed(1)}K`;
	return count.toString();
}

/**
 * Progress-bar colour, by cache hit and fill. Priority mirrors pi-emote: a
 * cold cache (0 < hit < 50%) is the alarming one, then a nearly-full context,
 * then a healthy cache. A hit rate of exactly 0 is treated as "no cache data
 * yet" and stays neutral, matching pi-emote — a genuine 0% is indistinguishable
 * from an empty session here.
 */
export function resolveProgressColor(
	percent: number,
	cacheHitRate: number,
): "error" | "warning" | "success" | "text" {
	if (cacheHitRate > 0 && cacheHitRate < 50) return "error";
	if (percent >= 75) return "warning";
	if (cacheHitRate >= 50) return "success";
	return "text";
}

const EIGHTH_BLOCKS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

/**
 * Foam frames for the waterline pulse. The empty entries let the ripple fade in
 * and out; index 0 is flat water, what an idle pet shows.
 */
export const TIDE_FOAM_FRAMES = ["", "≈", "~", "≈", ""] as const;

/** Slow cadence for the text-only waterline pulse (the avatar keeps its own). */
const TIDE_PULSE_MS = 300;

/** Preferred gauge width; it shrinks only when the terminal is too narrow. */
const TIDE_BAR_CELLS = 20;

/**
 * Context bar for the status panel: fresh input as `█`, cached prompt as `░`,
 * a horizontal eighth-block leading edge, and a one-cell foam glyph riding the
 * waterline (`foam` = "" for calm). Fills the requested cell count so the row
 * can share its width with a right-aligned percentage.
 */
export function buildTideBar(stats: PetStats, cells: number, foam = ""): string {
	if (cells <= 0) return "";
	const percent = Math.max(0, Math.min(100, stats.contextPercent ?? 0));
	const totalSubs = cells * 8;
	const filledSubs = percent === 0 ? 0 : Math.max(1, Math.round((percent / 100) * totalSubs));
	const cacheRatio = Math.max(0, Math.min(1, (stats.cacheHitRate ?? 0) / 100));
	const cacheSubs = Math.round(filledSubs * cacheRatio);
	const out: string[] = [];
	for (let i = 0; i < cells; i++) {
		const start = i * 8;
		const end = start + 8;
		const cacheIn = Math.max(0, Math.min(cacheSubs, end) - start);
		const inputIn = Math.max(0, Math.min(filledSubs, end) - Math.max(cacheSubs, start));
		const filled = cacheIn + inputIn;
		if (filled >= 8) out.push(inputIn > 0 ? "█" : "░");
		else if (filled > 0) out.push(EIGHTH_BLOCKS[filled - 1] as string);
		else out.push(" ");
	}
	if (foam.length > 0) {
		const edge = out.indexOf(" ");
		if (edge !== -1) out[edge] = foam;
	}
	return out.join("");
}


/** Replace a leading home directory with `~`, like Pi's own footer. */
function shortenHome(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home !== undefined && home.length > 0 && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * Sanitize a `ui.setStatus` entry for a single line. Pi's footer folds newlines,
 * tabs and carriage returns; this also folds the remaining C0/DEL control
 * characters so a stray escape cannot bleed into the strip, then collapses runs.
 */
export function sanitizeStatusText(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * Extension statuses in a stable order, matching Pi's footer (sorted by key).
 */
export function formatStatuses(statuses: ReadonlyMap<string, string>): string {
	return Array.from(statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter((text) => text.length > 0)
		.join(" ");
}

export class WhalePetWidget implements Component {
	private readonly tui: TUI;
	private readonly theme: PetTheme;
	/**
	 * One Kitty image id shared by every frame. Reusing the id makes the
	 * terminal *replace* the placed image instead of accumulating one per frame;
	 * pi-tui's `imageId` option documents exactly this animation use.
	 */
	private readonly imageId = allocateImageId();
	private readonly images = new Map<string, Image>();
	private readonly withAvatar: boolean;
	/**
	 * Footer-owned data (git branch, `ui.setStatus` entries, provider count).
	 * Absent when the widget is mounted as a plain widget (e.g. under test),
	 * in which case those fields simply stay blank.
	 */
	private readonly footerData: PetFooterData | undefined;
	private readonly unsubscribeBranch: (() => void) | undefined;
	private view: PetViewModel;
	private index = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(tui: TUI, theme: PetTheme, view: PetViewModel, footerData?: PetFooterData) {
		this.tui = tui;
		this.theme = theme;
		this.view = view;
		this.footerData = footerData;
		this.withAvatar = getCapabilities().images === "kitty";
		// The branch can change under us (checkout, rebase); Pi's footer redraws on
		// that signal, and so must this one or the strip keeps a stale branch.
		this.unsubscribeBranch = footerData?.onBranchChange(() => {
			if (!this.closed) this.tui.requestRender();
		});
		this.arm();
	}

	/** Apply a partial update; a state change restarts the cycle at frame 0. */
	update(view: Partial<PetViewModel>): void {
		if (this.closed) return;
		const next: PetViewModel = { ...this.view, ...view };
		const changed =
			next.state !== this.view.state ||
			next.model !== this.view.model ||
			next.thinkingLevel !== this.view.thinkingLevel ||
			next.stats !== this.view.stats;
		if (next.state !== this.view.state) {
			this.index = 0;
			this.view = next;
			this.arm();
		} else {
			this.view = next;
		}
		if (changed) this.tui.requestRender();
	}

	dispose(): void {
		this.closed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.unsubscribeBranch?.();
		this.images.clear();
	}

	invalidate(): void {
		for (const image of this.images.values()) image.invalidate();
		// `stateColumns` is derived from the terminal's cell dimensions, which a
		// resize can change. Drop it so the next render reserves columns against
		// the current cell size instead of the pre-resize one.
		stateColumnCache.clear();
	}

	render(width: number): string[] {
		const cycle = PET_CYCLES[this.view.state];
		const frame = cycle[this.index % cycle.length];
		const avatar = this.withAvatar && frame !== undefined ? this.avatarLines(frame.asset, width) : [];
		// `Image.render` returns the graphics escape on its first line and blanks for
		// the rest (see the module header). Guard that contract: a first line without
		// the escape means no frame was drawn, and a divider beside the blank tail
		// would be a half-empty strip. Degrade to the text-only layout instead of
		// trusting a shape a future pi-tui might stop producing.
		const hasAvatar = avatar.length > 0 && (avatar[0] ?? "").includes(KITTY_ESCAPE_PREFIX);
		// One colour lookup per render: the editor recolours its border whenever
		// the thinking level changes, and every rule in the strip follows it.
		const color = this.borderColor();
		const divider = color(DIVIDER_CHAR);
		const text = this.infoLines(width, hasAvatar);
		// Self-heal the frame loop. If a tick was ever lost — a coalesced render, a
		// throw between ticks, a bad index — restart it the moment Pi draws the
		// strip, so the image can never stay frozen on its last drawn frame.
		if (!this.closed && this.timer === undefined) this.arm();
		// The separator comes first, so the strip reads as a panel that the
		// editor's own top border closes at the bottom.
		const lines: string[] = [this.rule(width, color)];
		if (!hasAvatar) {
			for (const line of text) lines.push(line);
			return lines;
		}
		// Centre the frame inside a fixed slot. Frames are normalised to a square
		// canvas so every pose occupies the same number of columns, and the
		// centring keeps the gap to the divider symmetric and state-independent.
		const offset = avatarInset(stateColumns(this.view.state));
		// The reserved block is exactly the image's own row count: that is what
		// pi-tui reads back out of the escape to decide how many rows to clear and
		// redraw atomically. Every cursor step and blank line below is measured in
		// `block`, never in the panel, so the two can never disagree even if a future
		// status line grew past the frame. A trailing line beyond the block would be
		// treated as ordinary text, cleared with `ESC[2K`, and the "stuck head" bug
		// would return.
		const block = avatar.length;
		// Center the status block against the avatar so the strip does not look
		// top-heavy. A panel taller than the frame is clamped to the block for the
		// same reason: rows the image block cannot reach are drawn below it.
		const top = Math.max(0, Math.floor((block - text.length) / 2));
		const right = (row: number): string => {
			const index = row - top;
			return index >= 0 && index < text.length ? (text[index] as string) : "";
		};
		// The frame is a *multi-row* Kitty image anchored on one line, but pi-tui
		// only treats it as a block when the lines *after* it are empty: it then
		// clears those rows itself and draws the frame across them. With panel text
		// on those rows, pi-tui clears each row individually (ESC[2K), which detaches
		// the image from their cells and leaves only its top row — the "stuck head"
		// bug. So the panel is drawn by cursor movement *inside* the anchor line and
		// the trailing lines are left empty, keeping the block reserved and redrawn
		// atomically. (`Image.render` already returns blanks after the escape, so
		// those lines only need to exist, not to repeat the sequence.)
		let anchor = " ".repeat(offset) + (avatar[0] ?? "");
		anchor += `\x1b[${AVATAR_SLOT_COLUMNS - offset}C` + divider + " " + right(0);
		for (let row = 1; row < block; row++) {
			anchor += `\x1b[1B\r\x1b[${AVATAR_SLOT_COLUMNS}C` + divider + " " + right(row);
		}
		anchor += `\x1b[${block - 1}A`;
		lines.push(anchor);
		for (let row = 1; row < block; row++) lines.push("");
		// A terminal can size the avatar to fewer rows than the panel needs (tall
		// or narrow cells, common over SSH and serial links), and the image block
		// can only ever reserve its own rows. Any panel row the block did not reach
		// is emitted as an ordinary text line below it; without this the lower rows
		// were silently dropped and the strip showed only its head. The count stays
		// fixed at `max(block, text.length)` rows either way, so the strip never
		// changes height when the frame size shifts.
		const indent = " ".repeat(textColumn());
		for (let index = block - top; index < text.length; index++) {
			lines.push(truncateToWidth(indent + (text[index] as string), width));
		}
		return lines;
	}

	/**
	 * The editor's current border colour, shared by the strip's horizontal
	 * separator and its vertical divider. Re-derived on every render rather than
	 * cached: the editor's `borderColor` follows the thinking level, so a colour
	 * captured at mount time would drift out of sync the moment the user cycles
	 * levels.
	 */
	private borderColor(): (text: string) => string {
		return this.theme.getThinkingBorderColor(this.view.thinkingLevel);
	}

	/**
	 * Separator drawn above the strip. Both the glyph and the colour are copied
	 * from the editor's own border (pi-tui `editor.js`: `"─".repeat(width)`
	 * painted with `borderColor`), so the two lines read as one frame instead of
	 * a floating avatar over a boxed input.
	 */
	private rule(width: number, color: (text: string) => string): string {
		return color(RULE_CHAR.repeat(Math.max(1, width)));
	}

	private avatarLines(asset: string, width: number): string[] {
		if (loadFrame(asset) === null) return [];
		return this.imageFor(asset).render(width);
	}

	/** One `Image` per asset: `Image` caches its own rendered lines per width. */
	private imageFor(asset: string): Image {
		const cached = this.images.get(asset);
		if (cached !== undefined) return cached;
		const data = loadFrame(asset);
		const image = new Image(
			data ?? "",
			"image/png",
			{ fallbackColor: (text) => this.theme.fg("muted", text) },
			{
				maxWidthCells: AVATAR_MAX_COLUMNS,
				maxHeightCells: AVATAR_MAX_ROWS,
				filename: framePath(asset),
				imageId: this.imageId,
			},
		);
		this.images.set(asset, image);
		return image;
	}

	/**
	 * The four-line status panel beside the avatar. Everything is inline and
	 * left-aligned so a wide terminal leaves no dead space between a label and
	 * its value: identity (`🐳 model · 🔌 provider · 🧠 level`), a fixed-width
	 * context gauge with its reading beside it, a usage meter, and a location
	 * row led by the git branch. Without a `stats` snapshot only the identity
	 * line is drawn, so a host that has not wired the data yet degrades to a
	 * readable strip instead of a half-empty one.
	 */
	private infoLines(width: number, hasAvatar: boolean): string[] {
		const budget = Math.max(1, width - (hasAvatar ? textColumn() : 0));
		const { model, thinkingLevel, stats } = this.view;
		const thinking = this.theme.getThinkingBorderColor(thinkingLevel);
		// Row 1: identity. Provider and level only add their icon when present.
		const identity = [`🐳 ${model}`];
		if (stats?.provider) identity.push(`🔌 ${stats.provider}`);
		if (stats?.reasoning) identity.push(`🧠 ${thinkingLevel}`);
		const lines = [this.theme.bold(thinking(identity.join(" · ")))];
		if (stats) {
			// Row 2: the gauge keeps a fixed width so its reading stays beside it
			// instead of drifting to the far edge on a wide screen.
			const percent = stats.contextPercent ?? 0;
			const color = resolveProgressColor(percent, stats.cacheHitRate ?? 0);
			const tokens = stats.contextTokens !== null ? formatTokens(stats.contextTokens) : "?";
			const percentText = stats.contextPercent !== null ? `${percent.toFixed(1)}%` : "?";
			const reading = `${percentText} · ${tokens}/${formatTokens(stats.contextWindow)}`;
			const barCells = Math.max(6, Math.min(TIDE_BAR_CELLS, budget - visibleWidth(reading) - 5));
			const foam =
				this.view.state === "working"
					? (TIDE_FOAM_FRAMES[this.index % TIDE_FOAM_FRAMES.length] as string)
					: "";
			const gauge = this.theme.fg(color, `[${buildTideBar(stats, barCells, foam)}]`);
			lines.push(`${gauge} · ${this.theme.fg("dim", reading)}`);
			// Row 3: usage meter, all inline.
			lines.push(this.theme.fg("dim", this.usageMeter(stats)));
			// Row 4: location, branch first because it is the field that changes.
			lines.push(this.tideLocation(stats));
		}
		return lines.map((line) => truncateToWidth(line, budget));
	}

	/** `↑in ↓out · R… W… · ⚡hit% · 🍚 cost` for the usage row. */
	private usageMeter(stats: PetStats): string {
		const parts = [`↑${formatTokens(stats.inputTokens)} ↓${formatTokens(stats.outputTokens)}`];
		if (stats.cacheRead > 0 || stats.cacheWrite > 0) {
			parts.push(`R${formatTokens(stats.cacheRead)} W${formatTokens(stats.cacheWrite)}`);
		}
		if (stats.cacheHitRate !== null && (stats.cacheRead > 0 || stats.cacheWrite > 0)) {
			parts.push(`⚡${stats.cacheHitRate.toFixed(1)}%`);
		}
		if (stats.cost > 0) parts.push(`🍚 ${stats.cost.toFixed(3)}`);
		return parts.join(" · ");
	}

	/** `🪾 branch · 📂 cwd · session · statuses` for the location row. */
	private tideLocation(stats: PetStats): string {
		const parts: string[] = [];
		const branch = this.footerData?.getGitBranch();
		if (branch) parts.push(this.theme.fg("accent", `🪾 ${branch}`));
		parts.push(this.theme.fg("dim", `📂 ${shortenHome(stats.cwd)}`));
		if (stats.sessionName) parts.push(this.theme.fg("muted", stats.sessionName));
		const statuses = this.footerData ? formatStatuses(this.footerData.getExtensionStatuses()) : "";
		if (statuses.length > 0) parts.push(this.theme.fg("warning", statuses));
		return parts.join(" · ");
	}

	/**
	 * Advance one frame, then re-arm. `unref` keeps a pending pet timer from
	 * holding the process open — the widget must never be the reason Pi cannot
	 * exit.
	 */
	private arm(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.closed) return;
		const cycle = PET_CYCLES[this.view.state];
		// A missing frame reference must never be able to strand the loop: fall
		// back to the first frame so a bad index degrades to a static pose, not a
		// dead animation.
		const frame = cycle[this.index % cycle.length] ?? cycle[0];
		const advancing = this.withAvatar && frame !== undefined && cycle.length > 1;
		// Text-only strips have no avatar to animate, but the tide waterline still
		// ripples while a turn runs; that needs its own (slower) timer.
		const pulsing = !advancing && this.view.state === "working" && this.view.stats !== undefined;
		if (!advancing && !pulsing) return;
		const delay = advancing && frame !== undefined ? frame.durationMs : TIDE_PULSE_MS;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.closed) return;
			const current = PET_CYCLES[this.view.state];
			this.index = advancing ? (this.index + 1) % current.length : this.index + 1;
			// Re-arm *before* requesting the render. `requestRender` is
			// fire-and-forget: its frame can be coalesced away or throw, and when it
			// ran before `arm()` a single failure killed the whole frame loop, leaving
			// the image frozen on its last drawn frame.
			this.arm();
			this.tui.requestRender();
		}, delay);
		this.timer.unref?.();
	}
}
