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
 * - The pet strip is display-only: it is an extension widget
 *   above the editor, driven by agent lifecycle events, and it never calls
 *   `sendMessage`/`appendEntry`. It has its own `/whale pet` switch because it
 *   is a display preference rather than part of the persona.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { WHALE_PERSONA, WHALE_VOICE_RULE, WHALE_TAIL_ANCHOR } from "./persona.js";
import { WhalePetWidget, type PetStats } from "./pet.js";

const SECTION_NAME = "whale_persona";
const STATE_FILE = "whale-chan.json";
/** Widget key for the animated pet strip above the editor. */
const PET_WIDGET_KEY = "whale_pet";

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

type SessionManager = NonNullable<PetContext["sessionManager"]>;
type SessionEntry = ReturnType<SessionManager["getEntries"]>[number];

interface UsageTotals {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	latestInput: number;
	latestCacheRead: number;
	latestCacheWrite: number;
}

function emptyUsage(): UsageTotals {
	return { inputTokens: 0, outputTokens: 0, cost: 0, latestInput: 0, latestCacheRead: 0, latestCacheWrite: 0 };
}

/**
 * Running assistant-usage totals, folded incrementally out of the session's
 * entries. Pi's session is append-only ("entries cannot be modified or
 * deleted"), so a session that only grew since the last call resumes from
 * `consumed` instead of re-walking every entry — walking everything on every
 * event was O(n²) over a long session.
 */
export interface UsageAccumulator {
	manager: unknown;
	consumed: number;
	anchor: SessionEntry | undefined;
	totals: UsageTotals;
}

export function createUsageAccumulator(): UsageAccumulator {
	return { manager: undefined, consumed: 0, anchor: undefined, totals: emptyUsage() };
}

/**
 * Fold the session's assistant usage into `acc` and return the running totals.
 * The `anchor` identity check keeps the resume honest: a different manager, a
 * shrink, or a replaced entry list forces a rebuild, so a session switch can
 * never inherit stale totals. History is best-effort: a manager that throws
 * degrades to whatever has already been accumulated.
 */
export function accumulateUsage(acc: UsageAccumulator, manager: SessionManager | undefined): UsageTotals {
	let entries: readonly SessionEntry[];
	try {
		entries = manager?.getEntries() ?? [];
	} catch {
		return acc.totals;
	}
	const resumable =
		acc.manager === manager &&
		acc.consumed <= entries.length &&
		(acc.consumed === 0 || entries[acc.consumed - 1] === acc.anchor);
	if (!resumable) {
		acc.consumed = 0;
		acc.anchor = undefined;
		acc.totals = emptyUsage();
	}
	for (let i = acc.consumed; i < entries.length; i++) {
		const entry = entries[i];
		if (entry === undefined || entry.type !== "message" || entry.message.role !== "assistant") continue;
		const messageUsage = entry.message.usage;
		if (!messageUsage) continue;
		acc.totals.inputTokens += messageUsage.input ?? 0;
		acc.totals.outputTokens += messageUsage.output ?? 0;
		acc.totals.cost += messageUsage.cost?.total ?? 0;
		acc.totals.latestInput = messageUsage.input ?? 0;
		acc.totals.latestCacheRead = messageUsage.cacheRead ?? 0;
		acc.totals.latestCacheWrite = messageUsage.cacheWrite ?? 0;
	}
	acc.manager = manager;
	acc.consumed = entries.length;
	acc.anchor = entries[entries.length - 1];
	return acc.totals;
}

/**
 * Snapshot the session stats the strip renders. Best-effort: the accumulation
 * and `getContextUsage` are defensive, so a stub runtime degrades to zeros or
 * the model line instead of throwing mid-render.
 */
function petStats(ctx: PetContext, acc: UsageAccumulator): PetStats {
	const usage = ctx.getContextUsage?.();
	const model = ctx.model;
	const totals = accumulateUsage(acc, ctx.sessionManager);
	const promptTokens = totals.latestInput + totals.latestCacheRead + totals.latestCacheWrite;
	return {
		reasoning: model?.reasoning === true,
		contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
		contextTokens: usage?.tokens ?? null,
		contextPercent: usage?.percent ?? null,
		inputTokens: totals.inputTokens,
		outputTokens: totals.outputTokens,
		cacheHitRate: promptTokens > 0 ? (totals.latestCacheRead / promptTokens) * 100 : 0,
		cost: totals.cost,
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
	// Incremental token/cost fold for the status panel. One per extension
	// instance; the accumulator rebuilds itself when the session changes.
	const usageAcc = createUsageAccumulator();

	// The pet is UI-only: it renders in Pi's widget container above the editor and
	// never touches the prompt. `setWidget` with a factory is the documented path
	// for persistent content near the editor, and its default placement is
	// `aboveEditor` — exactly the status strip we want.
	const mountPet = (ctx: PetContext): void => {
		if (petWidget !== null) {
			// A second session_start without a shutdown should re-point the live
			// strip at the new context instead of leaving it bound to the old one.
			petWidget.update({
				model: modelLabel(ctx.model),
				thinkingLevel: ctx.thinkingLevel ?? "off",
				stats: petStats(ctx, usageAcc),
			});
			return;
		}
		ctx.ui.setWidget(PET_WIDGET_KEY, (tui, theme) => {
			const widget = new WhalePetWidget(tui, theme, {
				state: "idle",
				model: modelLabel(ctx.model),
				thinkingLevel: ctx.thinkingLevel ?? "off",
				stats: petStats(ctx, usageAcc),
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
			ctx.ui.notify("[whale-chan] corrupt config: invalid values reset to defaults", "warning");
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
			stats: petStats(ctx, usageAcc),
		});
	});

	// Context usage and token totals move with every assistant message, so the
	// panel is refreshed as they land rather than only at the turn boundary.
	pi.on("message_end", (_event, ctx) => {
		petWidget?.update({ stats: petStats(ctx, usageAcc) });
	});

	pi.on("agent_end", () => {
		petWidget?.update({ state: "idle" });
	});

	pi.on("agent_settled", (_event, ctx) => {
		petWidget?.update({ state: "idle", stats: petStats(ctx, usageAcc) });
	});

	// The strip's separator copies the editor's border colour, and the editor
	// recolours that border on every thinking-level change. Without this the
	// strip would keep the old colour and the two rules would visibly disagree.
	pi.on("thinking_level_select", (event, ctx) => {
		petWidget?.update({ thinkingLevel: event.level, stats: petStats(ctx, usageAcc) });
	});

	// A mid-session model switch changes the model name and its capability set;
	// the panel follows it even before the next run starts.
	pi.on("model_select", (_event, ctx) => {
		petWidget?.update({ model: modelLabel(ctx.model), stats: petStats(ctx, usageAcc) });
	});

	pi.on("session_shutdown", () => {
		petWidget?.dispose();
		petWidget = null;
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
