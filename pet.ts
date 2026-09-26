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
	fg(color: "accent" | "muted" | "dim" | "text" | "success", text: string): string;
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

let cachedAvatarColumns: number | undefined;

/**
 * Widest column count across every frame of every state, so the text column
 * does not shift when the pet switches from idle to working. Computed once.
 */
export function avatarColumns(): number {
	if (cachedAvatarColumns !== undefined) return cachedAvatarColumns;
	const cell = getCellDimensions();
	let columns = 1;
	const seen = new Set<string>();
	for (const cycle of Object.values(PET_CYCLES)) {
		for (const frame of cycle) {
			if (seen.has(frame.asset)) continue;
			seen.add(frame.asset);
			const data = loadFrame(frame.asset);
			if (data === null) continue;
			const dims = getPngDimensions(data);
			if (dims === null) continue;
			columns = Math.max(columns, fitCells(dims.widthPx, dims.heightPx, cell.widthPx, cell.heightPx).columns);
		}
	}
	cachedAvatarColumns = columns;
	return columns;
}

/**
 * Columns reserved for the avatar. Equal to the frame box: the slot adds no
 * padding of its own, so the strip stays tight to the artwork. The frame keeps
 * whatever transparent margin its own PNG carries; the layout adds none.
 */
export const AVATAR_SLOT_COLUMNS = AVATAR_MAX_COLUMNS;

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
			next.thinkingLevel !== this.view.thinkingLevel;
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
		const offset = hasAvatar
			? Math.max(0, Math.floor((AVATAR_SLOT_COLUMNS - stateColumns(this.view.state)) / 2))
			: 0;
		const text = this.statusLines(width, hasAvatar);
		const rows = Math.max(avatar.length, text.length);
		// Center the two-line status block against the avatar so the strip does
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

	private statusLines(width: number, hasAvatar: boolean): string[] {
		const working = this.view.state === "working";
		const stateColor = working ? "accent" : "muted";
		const lines = [
			this.theme.fg("muted", "Model: ") + this.theme.fg("text", this.view.model),
			this.theme.fg("muted", "Status: ") + this.theme.fg(stateColor, this.view.state),
		];
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
