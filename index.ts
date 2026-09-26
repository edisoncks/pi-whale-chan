/**
 * Whale-chan Persona Extension
 *
 * Injects the DeepSeek whale-chan persona into the system prompt and registers
 * /whale to toggle it. The preference persists in the Pi agent dir.
 *
 * Cache-safety contract (see ARCHITECTURE.md):
 * - We mutate event.systemPromptOptions.sections, never return systemPrompt
 *   and never set forceSystemPrompt. Pi therefore emits a section diff patch
 *   instead of a full-prompt checkpoint.
 * - The persona text is a frozen constant (persona.ts): no cwd/date/model
 *   interpolation, so re-setting it every turn produces no diff.
 * - Custom sections render after `cwd`, so a toggle only moves the prompt tail.
 * - The persona is bookended: the full text is the tail section, and a short
 *   voice rule is merged into the early `rules` section via promptGuidelines.
 *   Both are frozen constants and injection is idempotent, so the bookend is
 *   still diff-free while the persona stays on.
 * - Bookends live in the system prompt, which sits before all tool output, so
 *   they cannot anchor generation that follows a tool result. One append-only
 *   recency anchor closes that gap: a transient user-role tail anchor via the
 *   `context` event. A clean `bookend` vs `full` ablation at n=30/arm measures
 *   the gain (+10pp in-character, +10pp language match); see ARCHITECTURE.md.
 *   It is a pure append, so it cannot invalidate the cached prefix. (A second,
 *   tool-result anchor was tried and removed: it showed no measurable effect —
 *   see eval/README.md.)
 * - The avatar is display-only: a `whale_avatar` custom entry appended before
 *   each assistant message, rendered inline by an entry renderer. Custom
 *   entries never enter the LLM context, so the avatar cannot change the prompt,
 *   its diff, or the cache. TUI only: other modes have no entry renderers.
 * - The pet strip is display-only in the same way: it is an extension widget
 *   above the editor, driven by agent lifecycle events, and it never calls
 *   `sendMessage`/`appendEntry`. It has its own `/whale pet` switch because it
 *   is a display preference rather than part of the persona.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Box, getCellDimensions, Image, Text } from "@earendil-works/pi-tui";
import { WHALE_PERSONA, WHALE_VOICE_RULE, WHALE_TAIL_ANCHOR } from "./persona.js";
import { WhalePetWidget, type PetStats } from "./pet.js";

const SECTION_NAME = "whale_persona";
const STATE_FILE = "whale-chan.json";
/** Widget key for the animated pet strip above the editor. */
const PET_WIDGET_KEY = "whale_pet";

const AVATAR_ENTRY_TYPE = "whale_avatar";
const AVATAR_SIZE_PX = 200;
// The TUI draws whale-chan-avatar.png (256px, downscaled from the 1254px
// whale-chan.webp original). `Image` transmits PNG (`f=100`), the common
// denominator: Kitty also accepts raw RGB/RGBA (`f=24`/`f=32`) but has no webp
// payload type, so the full-resolution webp rendered as blank rows there.
// Drawing at ~200px from a 256px source keeps each inline re-transmission
// cheap.
const AVATAR_MIME = "image/png";
const AVATAR_PATH = join(dirname(fileURLToPath(import.meta.url)), "assets", "whale-chan-avatar.png");

interface WhaleAvatarData {
	/** Target edge length in pixels. Recorded so entries stay self-describing. */
	px: number;
}

/**
 * Mechanism switches — ablation only. Production (Pi) calls the factory with one
 * argument and gets every mechanism; the eval harness passes explicit flags so
 * an effect can be attributed to a single mechanism (see eval/run.ts). Defaults
 * keep production behavior byte-identical.
 */
export interface WhaleMechanisms {
	/** Tail section: the full persona body (`WHALE_PERSONA`). */
	readonly persona?: boolean;
	/** Head rule: `WHALE_VOICE_RULE` merged into `promptGuidelines`. */
	readonly headRule?: boolean;
	/** Transient user-role tail anchor after a tool result. */
	readonly tailAnchor?: boolean;
}

const ALL_MECHANISMS: Required<WhaleMechanisms> = {
	persona: true,
	headRule: true,
	tailAnchor: true,
};

// No agent dir: memory-only. Never fall back to a relative path and litter
// the user's CWD with a state file.
function statePath(): string | null {
	try {
		return join(getAgentDir(), STATE_FILE);
	} catch {
		return null;
	}
}

// Lazy and cached: read once per process, never in the factory (some
// invocations load extensions without starting a session). A missing or
// unreadable asset disables the image, never the turn — the renderer shows a
// text badge instead.
let avatarBase64: string | null | undefined;

function loadAvatarBase64(): string | null {
	if (avatarBase64 !== undefined) return avatarBase64;
	try {
		avatarBase64 = readFileSync(AVATAR_PATH).toString("base64");
	} catch {
		avatarBase64 = null;
	}
	return avatarBase64;
}

/** Persisted preferences. `pet` is independent of `enabled` on purpose. */
export interface WhaleConfig {
	/** Whether the persona is injected into the system prompt. */
	enabled: boolean;
	/** Whether the animated pet strip is shown above the editor. */
	pet: boolean;
}

const DEFAULT_CONFIG: WhaleConfig = { enabled: true, pet: true };

// Single parse: absent keys read as their defaults, bad values flag corrupt.
// Pure read: never writes, warns, or notifies. Why no existsSync: stat-then-read
// is TOCTOU; try the read directly. ENOENT means "no config yet" (defaults),
// parse/shape failure means corrupt. Other IO errors fail open silently.
function loadConfig(): { config: WhaleConfig; corrupt: boolean } {
	const path = statePath();
	if (path === null) return { config: { ...DEFAULT_CONFIG }, corrupt: false };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { config: { ...DEFAULT_CONFIG }, corrupt: false };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { config: { ...DEFAULT_CONFIG }, corrupt: true };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { config: { ...DEFAULT_CONFIG }, corrupt: true };
	}
	const record = raw as { enabled?: unknown; pet?: unknown };
	// Each key is validated independently, so one bad value cannot discard a good
	// sibling. An absent key is not corruption: it is a first run, or a config
	// written before that key existed.
	let corrupt = false;
	let enabled = DEFAULT_CONFIG.enabled;
	let pet = DEFAULT_CONFIG.pet;
	if (record.enabled !== undefined) {
		if (typeof record.enabled === "boolean") enabled = record.enabled;
		else corrupt = true;
	}
	if (record.pet !== undefined) {
		if (typeof record.pet === "boolean") pet = record.pet;
		else corrupt = true;
	}
	return { config: { enabled, pet }, corrupt };
}

// Returns null on success, otherwise a human-readable reason (never throws).
// Surfacing the reason keeps a real support report diagnosable: EACCES means
// permissions, ENOSPC means disk, ENOTDIR means the agent dir itself is wrong.
function saveConfig(config: WhaleConfig): string | null {
	try {
		const path = statePath();
		if (path === null) return null;
		// Atomic save: tmp + rename so a crash never leaves a half-file.
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify(config, null, 2));
		renameSync(tmp, path);
		return null;
	} catch (e) {
		// Persistence must never crash the agent. Caller warns with the reason.
		return e instanceof Error ? e.message : String(e);
	}
}

/** Label for the pet strip; falls back so a missing name never blanks the line. */
function modelLabel(model: ExtensionContext["model"]): string {
	return model?.name ?? model?.id ?? "unknown";
}

/**
 * The slice of `ExtensionContext` the pet panel reads. Every stats source is
 * optional, so a stub runtime that only exposes `ui`/`model` still mounts the
 * strip — it simply renders the model line.
 */
type PetContext = {
	ui: ExtensionUIContext;
	model: ExtensionContext["model"];
	thinkingLevel?: ExtensionContext["thinkingLevel"];
	getContextUsage?: ExtensionContext["getContextUsage"];
	sessionManager?: ExtensionContext["sessionManager"];
	cwd?: string;
};

/**
 * Snapshot the session stats the strip renders. Best-effort: the session walk
 * is wrapped so a runtime without a session manager degrades to zeros instead
 * of throwing mid-render.
 */
function petStats(ctx: PetContext): PetStats {
	const usage = ctx.getContextUsage?.();
	const model = ctx.model;
	let inputTokens = 0;
	let outputTokens = 0;
	let cost = 0;
	let latestInput = 0;
	let latestCacheRead = 0;
	let latestCacheWrite = 0;
	try {
		for (const entry of ctx.sessionManager?.getEntries() ?? []) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const messageUsage = entry.message.usage;
			if (!messageUsage) continue;
			inputTokens += messageUsage.input ?? 0;
			outputTokens += messageUsage.output ?? 0;
			cost += messageUsage.cost?.total ?? 0;
			latestInput = messageUsage.input ?? 0;
			latestCacheRead = messageUsage.cacheRead ?? 0;
			latestCacheWrite = messageUsage.cacheWrite ?? 0;
		}
	} catch {
		// Session history is best-effort; the panel falls back to zeros.
	}
	const promptTokens = latestInput + latestCacheRead + latestCacheWrite;
	return {
		reasoning: model?.reasoning === true,
		contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
		contextTokens: usage?.tokens ?? null,
		contextPercent: usage?.percent ?? null,
		inputTokens,
		outputTokens,
		cacheHitRate: promptTokens > 0 ? (latestCacheRead / promptTokens) * 100 : 0,
		cost,
		cwd: ctx.cwd ?? process.cwd(),
	};
}

export default function whaleChan(pi: ExtensionAPI, mechanisms: WhaleMechanisms = {}) {
	const M = { ...ALL_MECHANISMS, ...mechanisms };
	// Fail-open defaults; no IO at factory time. session_start is the single
	// source of truth for config.
	let enabled = true;
	let petEnabled = true;
	// Assigned by the widget factory Pi invokes from `setWidget`; null while the
	// strip is unmounted. That factory runs once per mount, so this stays the
	// single live instance the lifecycle handlers poke.
	let petWidget: WhalePetWidget | null = null;

	// The pet is UI-only: it renders in Pi's widget container above the editor and
	// never touches the prompt. `setWidget` with a factory is the documented path
	// for persistent content near the editor, and its default placement is
	// `aboveEditor` — exactly the status strip we want.
	const mountPet = (ctx: PetContext): void => {
		if (petWidget !== null) return;
		ctx.ui.setWidget(PET_WIDGET_KEY, (tui, theme) => {
			const widget = new WhalePetWidget(tui, theme, {
				state: "idle",
				model: modelLabel(ctx.model),
				thinkingLevel: ctx.thinkingLevel ?? "off",
				stats: petStats(ctx),
			});
			petWidget = widget;
			return widget;
		});
	};

	// Pi disposes the component itself when a widget is replaced or cleared; we
	// dispose first only so the frame timer is cancelled before the swap.
	const unmountPet = (ctx: { ui: ExtensionUIContext }): void => {
		petWidget?.dispose();
		petWidget = null;
		ctx.ui.setWidget(PET_WIDGET_KEY, undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		const { config, corrupt } = loadConfig();
		enabled = config.enabled;
		petEnabled = config.pet;
		if (corrupt) {
			ctx.ui.notify("[whale-chan] corrupt config reset to defaults", "warning");
			const persistError = saveConfig(config);
			if (persistError) {
				ctx.ui.notify(`[whale-chan] could not persist config: ${persistError}`, "warning");
			}
		}
		if (petEnabled && ctx.mode === "tui") {
			mountPet(ctx);
		}
	});

	// Busy window for the pet. `agent_start` fires once per run and `agent_settled`
	// once after retries resolve, so the strip stays "working" for a whole
	// tool-heavy turn instead of flickering between turns. The model label is
	// refreshed here so a mid-session model switch is reflected.
	pi.on("agent_start", (_event, ctx) => {
		petWidget?.update({
			state: "working",
			model: modelLabel(ctx.model),
			thinkingLevel: ctx.thinkingLevel ?? "off",
			stats: petStats(ctx),
		});
	});

	// Context usage and token totals move with every assistant message, so the
	// panel is refreshed as they land rather than only at the turn boundary.
	pi.on("message_end", (_event, ctx) => {
		petWidget?.update({ stats: petStats(ctx) });
	});

	pi.on("agent_end", () => {
		petWidget?.update({ state: "idle" });
	});

	pi.on("agent_settled", (_event, ctx) => {
		petWidget?.update({ state: "idle", stats: petStats(ctx) });
	});

	// The strip's separator copies the editor's border colour, and the editor
	// recolours that border on every thinking-level change. Without this the
	// strip would keep the old colour and the two rules would visibly disagree.
	pi.on("thinking_level_select", (event, ctx) => {
		petWidget?.update({ thinkingLevel: event.level, stats: petStats(ctx) });
	});

	// A mid-session model switch changes the model name and its capability set;
	// the panel follows it even before the next run starts.
	pi.on("model_select", (_event, ctx) => {
		petWidget?.update({ model: modelLabel(ctx.model), stats: petStats(ctx) });
	});

	pi.on("session_shutdown", () => {
		petWidget?.dispose();
		petWidget = null;
	});

	// Every assistant message is a reply, and a tool-heavy run emits several
	// (narration, then post-tool answers), so each one gets its own avatar.
	// The append must sort after the previous entry and before this assistant
	// entry: `before_agent_start`/`turn_start` fire before the user entry is
	// persisted, while by the assistant's `message_start` the previous message
	// is persisted and the assistant entry is not yet written (it lands at
	// message_end). That gap is exactly one reply.
	pi.on("message_start", (event, ctx) => {
		if (!enabled || ctx.mode !== "tui" || event.message.role !== "assistant") return;
		pi.appendEntry<WhaleAvatarData>(AVATAR_ENTRY_TYPE, { px: AVATAR_SIZE_PX });
	});

	// Display-only: custom entries are not part of the LLM context (see
	// ARCHITECTURE.md, "Why the avatar is a custom entry"). `Image` emits
	// Kitty/iTerm2 graphics where supported and falls back to a text badge
	// otherwise; a missing asset degrades to text, never to a failed render.
	pi.registerEntryRenderer<WhaleAvatarData>(AVATAR_ENTRY_TYPE, (entry, _options, theme) => {
		const base64 = loadAvatarBase64();
		const px = entry.data?.px ?? AVATAR_SIZE_PX;
		let avatar: Image | Text;
		if (base64 === null) {
			avatar = new Text(theme.fg("muted", "[whale-chan avatar unavailable]"), 0, 0);
		} else {
			const cell = getCellDimensions();
			avatar = new Image(base64, AVATAR_MIME, { fallbackColor: (text) => theme.fg("muted", text) }, {
				maxWidthCells: Math.max(1, Math.round(px / Math.max(1, cell.widthPx))),
				maxHeightCells: Math.max(1, Math.round(px / Math.max(1, cell.heightPx))),
				filename: AVATAR_PATH,
			});
		}
		// Custom entries render flush left, while transcript prose carries Pi's
		// output inset. EntryRenderOptions only exposes `expanded`, so the
		// configured outputPad is not reachable here; assume the default (1).
		// With outputPad=0 the prose goes flush left and this single-column
		// inset becomes a one-column drift.
		const box = new Box(1, 0);
		box.addChild(avatar);
		return box;
	});

	// Section patch, not prompt replacement: Pi diffs sections and appends only
	// what changed. Re-setting an unchanged frozen string yields no diff.
	//
	// Bookend: the full persona is the tail section, while WHALE_VOICE_RULE is
	// merged into the early `rules` section (promptGuidelines). Tool output is
	// appended after the system prompt and pushes the tail out of recency, so
	// the head rule is the counter-pressure.
	//
	// Each turn Pi calls `emitBeforeAgentStart`, which normalizes the base
	// options into a fresh clone before invoking handlers, so `guidelines` here
	// is a per-turn copy that never reaches `_baseSystemPromptOptions`. A bare
	// push could not accumulate across turns. The `includes` guard is defensive
	// insurance (should Pi ever hand handlers the shared base object), and
	// removal on `off` keeps a shared array consistent if that day comes.
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		const guidelines = options.promptGuidelines;
		// Tail section (persona body) and head rule (bookend) are independent
		// switches so the harness can isolate them; `off` clears both.
		if (enabled && M.persona) {
			options.sections[SECTION_NAME] = WHALE_PERSONA;
		} else {
			delete options.sections[SECTION_NAME];
		}
		if (enabled && M.headRule) {
			if (!guidelines.includes(WHALE_VOICE_RULE)) {
				guidelines.push(WHALE_VOICE_RULE);
			}
		} else {
			for (let i = guidelines.length - 1; i >= 0; i--) {
				if (guidelines[i] === WHALE_VOICE_RULE) guidelines.splice(i, 1);
			}
		}
	});

	// Authoritative tail anchor. `context` runs before every provider call
	// and Pi restores the message list afterward, so this append is transient.
	// It fires only when the last message is a tool result: that is the moment
	// generation follows tool output and the register is most likely to drift.
	// `custom` maps to user role (convertToLlm), so it carries instruction
	// authority the system-prompt bookend cannot reach at that position. A pure
	// tail append, so no cached prefix is invalidated.
	pi.on("context", (event) => {
		if (!enabled || !M.tailAnchor) return;
		const last = event.messages[event.messages.length - 1];
		if (!last || last.role !== "toolResult") return;
		const anchor = {
			role: "custom" as const,
			customType: "whale_tail_anchor",
			content: WHALE_TAIL_ANCHOR,
			display: false,
			timestamp: Date.now(),
		};
		return { messages: [...event.messages, anchor] };
	});

	pi.registerCommand("whale", {
		description: "Toggle the DeepSeek whale-chan persona and the animated pet strip",
		getArgumentCompletions: (prefix: string) => {
			const options = ["on", "off", "toggle", "status", "pet on", "pet off", "pet toggle"];
			return options.filter((o) => o.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();

			if (arg === "status") {
				ctx.ui.notify(
					`whale-chan persona: ${enabled ? "on" : "off"} · pet: ${petEnabled ? "on" : "off"}`,
					"info",
				);
				return;
			}

			// The pet has its own switch: it is a display preference, not part of the
			// persona, so turning the persona off must not hide the pet.
			if (arg === "pet" || arg === "pet on" || arg === "pet off" || arg === "pet toggle") {
				petEnabled = arg === "pet on" ? true : arg === "pet off" ? false : !petEnabled;
				const petPersistError = saveConfig({ enabled, pet: petEnabled });
				if (petPersistError) {
					ctx.ui.notify(`[whale-chan] could not persist setting: ${petPersistError}`, "warning");
					return;
				}
				if (petEnabled && ctx.mode === "tui") {
					mountPet(ctx);
				} else {
					unmountPet(ctx);
				}
				ctx.ui.notify(`whale-chan pet: ${petEnabled ? "on" : "off"}`, "info");
				return;
			}

			if (arg === "" || arg === "toggle") {
				enabled = !enabled;
			} else if (arg === "on") {
				enabled = true;
			} else if (arg === "off") {
				enabled = false;
			} else {
				ctx.ui.notify("Usage: /whale [on|off|toggle|status|pet on|pet off]", "warning");
				return;
			}

			const persistError = saveConfig({ enabled, pet: petEnabled });
			if (persistError) {
				ctx.ui.notify(`[whale-chan] could not persist setting: ${persistError}`, "warning");
				return;
			}
			ctx.ui.notify(enabled ? "whale-chan persona: on" : "whale-chan persona: off", "info");
		},
	});
}
