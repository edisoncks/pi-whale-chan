/**
 * Whale-chan pet widget — an animated avatar plus a model/status strip that Pi
 * draws above the editor.
 *
 * Display-only by construction: this renders inside Pi's extension widget
 * container and never calls `sendMessage`/`appendEntry`, so it cannot enter the
 * LLM context, change the system prompt, or invalidate a cached prefix.
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
 * Snapshot of the session stats the status panel renders. The four-line layout
 * mirrors pi-emote's info panel: model/level/window, context progress,
 * token+cost totals, and the working directory.
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
	/** Cache hit rate of the latest prompt, 0-100. */
	readonly cacheHitRate: number;
	readonly cost: number;
	readonly cwd: string;
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
 * a billboard. Every frame is normalised to a square 72×72 canvas, so both poses
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
 * Context progress bar. Cached tokens fill a cell as `░` and fresh input as
 * `█` (or an eighth-block for a partial cell). The minimum fill is one full
 * cell, so a non-zero context is always visible instead of rounding to nothing.
 */
export function buildProgressBar(stats: PetStats): string {
	const segments = 20;
	const subsPerSegment = 8;
	const totalSubs = segments * subsPerSegment;
	const percent = stats.contextPercent ?? 0;
	const filledSubs = percent === 0 ? 0 : Math.max(Math.ceil((percent / 100) * totalSubs), subsPerSegment);
	const cacheSubs = Math.floor(filledSubs * (stats.cacheHitRate / 100));
	const bar = Array.from({ length: segments }, (_, i) => {
		const start = i * subsPerSegment;
		const end = start + subsPerSegment;
		const cacheInSeg = Math.max(0, Math.min(cacheSubs, end) - start);
		const inputInSeg = Math.max(0, Math.min(filledSubs, end) - Math.max(cacheSubs, start));
		if (cacheInSeg > 0 && inputInSeg > 0) return "█";
		if (inputInSeg > 0) return EIGHTH_BLOCKS[inputInSeg - 1];
		if (cacheInSeg > 0) return "░";
		return " ";
	}).join("");
	const tokens = stats.contextTokens !== null ? formatTokens(stats.contextTokens) : "?";
	return `⏵▕${bar}▏ ${tokens} (${percent.toFixed(1)}%)`;
}

/** Replace a leading home directory with `~`, like Pi's own footer. */
function shortenHome(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	return home !== undefined && home.length > 0 && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
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
	private view: PetViewModel;
	private index = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(tui: TUI, theme: PetTheme, view: PetViewModel) {
		this.tui = tui;
		this.theme = theme;
		this.view = view;
		this.withAvatar = getCapabilities().images === "kitty";
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
		const hasAvatar = avatar.length > 0;
		// One colour lookup per render: the editor recolours its border whenever
		// the thinking level changes, and every rule in the strip follows it.
		const color = this.borderColor();
		const divider = color(DIVIDER_CHAR);
		// Centre the frame inside a fixed slot. Frames are normalised to a square
		// canvas so every pose occupies the same number of columns, and the
		// centring keeps the gap to the divider symmetric and state-independent.
		const offset = hasAvatar ? avatarInset(stateColumns(this.view.state)) : 0;
		const text = this.infoLines(width, hasAvatar);
		const rows = Math.max(avatar.length, text.length);
		// Center the four-line status block against the avatar so the strip does
		// not look top-heavy.
		const top = Math.max(0, Math.floor((rows - text.length) / 2));
		// The separator comes first, so the strip reads as a panel that the
		// editor's own top border closes at the bottom.
		const lines: string[] = [this.rule(width, color)];
		for (let row = 0; row < rows; row++) {
			const left = avatar[row] ?? "";
			const textIndex = row - top;
			const right = textIndex >= 0 && textIndex < text.length ? (text[textIndex] as string) : "";
			if (!hasAvatar) {
				lines.push(right);
			} else if (left.length > 0) {
				// The frame anchors on this row, after the centring spaces. `C=1`
				// leaves the cursor at `offset`, so the divider is one forward away,
				// and the spaces sit in cells the image does not cover.
				lines.push(
					" ".repeat(offset) + left + `\x1b[${AVATAR_SLOT_COLUMNS - offset}C` + divider + " " + right,
				);
			} else {
				// No image on this row: cursor-forward, so nothing paints over the
				// cells the frame already occupies.
				lines.push(`\x1b[${AVATAR_SLOT_COLUMNS}C` + divider + " " + right);
			}
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
	 * The four-line status panel beside the avatar. Line 1 carries the model, its
	 * thinking level, and the context window; line 2 the context progress bar;
	 * line 3 the token/cost totals; line 4 the working directory. Without a
	 * `stats` snapshot only the model line is drawn, so a host that has not wired
	 * the data yet degrades to a readable strip instead of a half-empty one.
	 */
	private infoLines(width: number, hasAvatar: boolean): string[] {
		const { model, thinkingLevel, stats } = this.view;
		const thinking = this.theme.getThinkingBorderColor(thinkingLevel);
		let modelLine = model;
		if (stats?.reasoning) modelLine += ` • ${thinkingLevel}`;
		if (stats) modelLine += ` • ${formatTokens(stats.contextWindow)}`;
		const lines = [this.theme.bold(thinking(modelLine))];
		if (stats) {
			const barColor = resolveProgressColor(stats.contextPercent ?? 0, stats.cacheHitRate);
			lines.push(this.theme.fg(barColor, buildProgressBar(stats)));
			lines.push(
				this.theme.fg(
					"dim",
					`↑${formatTokens(stats.inputTokens)} ↓${formatTokens(stats.outputTokens)} ` +
						`⇞${stats.cacheHitRate.toFixed(1)}% $${stats.cost.toFixed(3)}`,
				),
			);
			lines.push(this.theme.fg("warning", shortenHome(stats.cwd)));
		}
		const budget = Math.max(1, width - (hasAvatar ? textColumn() : 0));
		return lines.map((line) => truncateToWidth(line, budget));
	}

	/**
	 * Advance one frame, then re-arm. `unref` keeps a pending pet timer from
	 * holding the process open — the widget must never be the reason Pi cannot
	 * exit.
	 */
	private arm(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.closed || !this.withAvatar) return;
		const cycle = PET_CYCLES[this.view.state];
		const frame = cycle[this.index % cycle.length];
		if (frame === undefined || cycle.length <= 1) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.closed) return;
			const current = PET_CYCLES[this.view.state];
			this.index = (this.index + 1) % current.length;
			this.tui.requestRender();
			this.arm();
		}, frame.durationMs);
		this.timer.unref?.();
	}
}
