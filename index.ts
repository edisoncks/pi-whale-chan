/**
 * Whale-chan Persona Extension
 *
 * Injects the DeepSeek whale-chan persona into the system prompt and registers
 * /whale to toggle it. The preference persists in the Pi agent dir.
 *
 * Cache-safety contract (see ARCHITECTURE.md):
 * - We mutate event.systemPromptOptions.appendSystemPrompt, never return
 *   systemPrompt and never set forceSystemPrompt. Pi therefore emits a section
 *   diff patch instead of a full-prompt checkpoint.
 * - appendSystemPrompt renders as the `addendum` section, the same slot Pi uses
 *   for APPEND_SYSTEM.md, and Pi joins multiple sources with a blank line. So
 *   the persona sits after the user's own APPEND_SYSTEM.md content, and toggling
 *   it changes only that one section.
 * - PERSONA.md is read once and cached, so re-applying it every turn produces no
 *   diff and never invalidates the prompt cache while it stays on.
 * - Injection is idempotent and reversible: a prior copy is stripped before the
 *   fresh append, so a shared options object cannot accumulate copies.
 * - The pet strip is display-only: it sits above the editor as an extension
 *   widget and replaces Pi's built-in footer by mounting an empty footer (so
 *   the strip, not the footer, owns the status line). It is driven by agent
 *   lifecycle events and never calls `sendMessage`/`appendEntry`. It has its
 *   own `/whale pet` switch because it is a display preference rather than part
 *   of the persona.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { WhalePetWidget, type PetFooterData, type PetStats } from "./pet.js";

/**
 * Bundled persona text, read once (see `loadPersonaText`) and cached so the
 * injected `addendum` section is byte-stable across turns. `import.meta.url`
 * resolves next to this module in both the repo and an installed package.
 */
const PERSONA_PATH = new URL("./PERSONA.md", import.meta.url);
const STATE_FILE = "whale-chan.json";
/** Widget key for the animated pet strip above the editor. */
const PET_WIDGET_KEY = "whale_pet";

/**
 * Renders nothing. Mounted as Pi's footer while the strip is on, so the built-in
 * footer's status surface is replaced by the strip above the editor rather than
 * duplicated below it. `ctx.ui.setFooter(undefined)` restores the real footer.
 * This is the pattern from Pi's own `border-status-editor.ts` example.
 */
class EmptyFooter {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

/**
 * Mechanism switches — ablation only. Production (Pi) calls the factory with one
 * argument and gets the persona; the eval harness passes an explicit flag so the
 * flat-assistant baseline (`none`) can be compared against persona-on (`full`).
 */
export interface WhaleMechanisms {
	/** Append PERSONA.md to the system prompt's `addendum` section. */
	readonly persona?: boolean;
}

const ALL_MECHANISMS: Required<WhaleMechanisms> = {
	persona: true,
};

/**
 * Cached PERSONA.md text. `undefined` = not read yet, `null` = missing or
 * unreadable. Reading lazily keeps extension load IO-free; caching keeps the
 * injected section byte-stable across turns. `before_agent_start` is the read
 * point for headless sessions that never emit `session_start`.
 */
let personaText: string | null | undefined;

export function loadPersonaText(): string | null {
	if (personaText !== undefined) return personaText;
	try {
		personaText = readFileSync(PERSONA_PATH, "utf8").trim() || null;
	} catch {
		personaText = null;
	}
	return personaText;
}

/** Drop a prior trailing persona copy, so re-applying is idempotent/reversible. */
function withoutPersona(append: string, text: string): string {
	const suffix = `\n\n${text}`;
	return append.endsWith(suffix) ? append.slice(0, -suffix.length) : append;
}

/** The `appendSystemPrompt` value with the persona appended exactly once. */
function withPersona(append: string, text: string): string {
	const base = withoutPersona(append, text);
	return base ? `${base}\n\n${text}` : text;
}

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
	/** Whether the animated pet strip is shown above the editor, replacing the built-in footer. */
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

/** Session name for the location line; absent or unreadable degrades to null. */
function sessionNameLabel(ctx: PetContext): string | null {
	try {
		return ctx.sessionManager?.getSessionName() ?? null;
	} catch {
		return null;
	}
}

/** Provider display name for the strip (`OpenCode Go`), raw id as the fallback. */
function providerLabel(ctx: PetContext): string {
	const provider = ctx.model?.provider;
	if (!provider) return "unknown";
	try {
		return ctx.modelRegistry?.getProviderDisplayName(provider) ?? provider;
	} catch {
		return provider;
	}
}

/**
 * The slice of `ExtensionContext` the pet panel reads. Every stats source is
 * optional, so a stub runtime that only exposes `ui`/`model` still mounts the
 * strip — it simply renders the model line.
 */
type PetContext = {
	ui: ExtensionUIContext;
	model: ExtensionContext["model"];
	modelRegistry?: ExtensionContext["modelRegistry"];
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
	cacheReadTokens: number;
	cacheWriteTokens: number;
	latestInput: number;
	latestCacheRead: number;
	latestCacheWrite: number;
}

function emptyUsage(): UsageTotals {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		latestInput: 0,
		latestCacheRead: 0,
		latestCacheWrite: 0,
	};
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
		acc.totals.cacheReadTokens += messageUsage.cacheRead ?? 0;
		acc.totals.cacheWriteTokens += messageUsage.cacheWrite ?? 0;
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
	// Best-effort, like the accumulation below: a host whose `getContextUsage`
	// throws (or a stub that lacks it) degrades to the model line instead of
	// taking down the lifecycle handler that called us.
	let usage: ReturnType<NonNullable<PetContext["getContextUsage"]>> | undefined;
	try {
		usage = ctx.getContextUsage?.();
	} catch {
		usage = undefined;
	}
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
		cacheRead: totals.cacheReadTokens,
		cacheWrite: totals.cacheWriteTokens,
		cacheHitRate: promptTokens > 0 ? (totals.latestCacheRead / promptTokens) * 100 : null,
		cost: totals.cost,
		cwd: ctx.cwd ?? process.cwd(),
		sessionName: sessionNameLabel(ctx),
		provider: providerLabel(ctx),
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
	// Footer-owned data (git branch, `ui.setStatus` entries, provider count). It
	// is only reachable from the `setFooter` factory, so that factory stores it
	// and the widget above the editor reads it.
	let petFooterData: PetFooterData | undefined;
	// Incremental token/cost fold for the status panel. One per extension
	// instance; the accumulator rebuilds itself when the session changes.
	const usageAcc = createUsageAccumulator();

	// The pet is UI-only and never touches the prompt. It keeps its original
	// spot *above the editor* (as a widget); to make it *replace* the built-in
	// footer, a separate empty footer is mounted so the footer's status surface
	// is not duplicated below. Pi invokes the `setFooter` factory synchronously,
	// so `petFooterData` is captured before the widget factory below reads it.
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
		ctx.ui.setFooter((_tui, _theme, footerData) => {
			petFooterData = footerData;
			return new EmptyFooter();
		});
		ctx.ui.setWidget(PET_WIDGET_KEY, (tui, theme) => {
			const widget = new WhalePetWidget(
				tui,
				theme,
				{
					state: "idle",
					model: modelLabel(ctx.model),
					thinkingLevel: ctx.thinkingLevel ?? "off",
					stats: petStats(ctx, usageAcc),
				},
				petFooterData,
			);
			petWidget = widget;
			return widget;
		});
	};

	// Pi disposes the component itself when a widget is replaced or cleared; we
	// dispose first only so the frame timer is cancelled before the swap.
	// Clearing the widget and restoring the footer takes Pi's built-in footer
	// back.
	const unmountPet = (ctx: { ui: ExtensionUIContext }): void => {
		petWidget?.dispose();
		petWidget = null;
		ctx.ui.setWidget(PET_WIDGET_KEY, undefined);
		ctx.ui.setFooter(undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		const { config, corrupt } = loadConfig();
		enabled = config.enabled;
		petEnabled = config.pet;
		if (enabled && loadPersonaText() === null) {
			ctx.ui.notify("[whale-chan] PERSONA.md not found; persona will not be injected", "warning");
		}
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

	// The session name is edited live (via `/name` or the session picker) and it
	// rides on the location line, so refresh the panel when it changes.
	pi.on("session_info_changed", (_event, ctx) => {
		petWidget?.update({ stats: petStats(ctx, usageAcc) });
	});

	pi.on("session_shutdown", (_event, ctx) => {
		petWidget?.dispose();
		petWidget = null;
		// The widget and the hidden-footer state belong to the old session; drop
		// both so a switch back starts from the real footer.
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(PET_WIDGET_KEY, undefined);
			ctx.ui.setFooter(undefined);
			petFooterData = undefined;
		}
	});

	// Append the persona to the same `addendum` section Pi uses for
	// APPEND_SYSTEM.md: a section patch, not a prompt replacement, so Pi diffs
	// sections and sends only what changed. The persona is read once and cached,
	// so re-applying it every turn is diff-free while it stays on.
	//
	// Each turn Pi calls `emitBeforeAgentStart`, which normalizes the base
	// options into a fresh clone before invoking handlers; the base object (and
	// the user's own APPEND_SYSTEM.md content) is never mutated. The helpers are
	// still idempotent and reversible, so a hypothetical shared object could
	// neither accumulate copies nor keep the persona after `off`.
	pi.on("before_agent_start", (event) => {
		const text = loadPersonaText();
		if (text === null) return;
		const options = event.systemPromptOptions;
		const current = options.appendSystemPrompt ?? "";
		options.appendSystemPrompt =
			enabled && M.persona ? withPersona(current, text) : withoutPersona(current, text);
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
				// Apply the switch before persisting. A failed write must still flip the
				// live strip — the same in-session-but-not-remembered contract the persona
				// branch has — otherwise the flag and the UI disagree and `/whale status`
				// reports a state the strip is not showing.
				if (petEnabled && ctx.mode === "tui") {
					mountPet(ctx);
				} else {
					unmountPet(ctx);
				}
				const petPersistError = saveConfig({ enabled, pet: petEnabled });
				if (petPersistError) {
					ctx.ui.notify(`[whale-chan] could not persist setting: ${petPersistError}`, "warning");
					return;
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
			if (enabled && loadPersonaText() === null) {
				ctx.ui.notify("[whale-chan] PERSONA.md not found; persona will not be injected", "warning");
			}
			ctx.ui.notify(enabled ? "whale-chan persona: on" : "whale-chan persona: off", "info");
		},
	});
}
