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
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WHALE_PERSONA, WHALE_VOICE_RULE, WHALE_TAIL_ANCHOR } from "./persona.js";

const SECTION_NAME = "whale_persona";
const STATE_FILE = "whale-chan.json";

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

// Single parse: missing reads as on, corrupt reads as on + flags corrupt.
// Pure read: never writes, warns, or notifies. Why no existsSync: stat-then-read
// is TOCTOU; try the read directly. ENOENT means "no config yet" (default on),
// parse/shape failure means corrupt. Other IO errors fail open silently.
function loadConfig(): { enabled: boolean; corrupt: boolean } {
	const path = statePath();
	if (path === null) return { enabled: true, corrupt: false };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return { enabled: true, corrupt: false };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { enabled: true, corrupt: true };
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { enabled: true, corrupt: true };
	}
	{
		const enabled = (raw as { enabled?: unknown }).enabled;
		if (enabled === undefined) return { enabled: true, corrupt: false };
		if (typeof enabled === "boolean") return { enabled, corrupt: false };
	}
	return { enabled: true, corrupt: true };
}

// Returns null on success, otherwise a human-readable reason (never throws).
// Surfacing the reason keeps a real support report diagnosable: EACCES means
// permissions, ENOSPC means disk, ENOTDIR means the agent dir itself is wrong.
function saveEnabled(enabled: boolean): string | null {
	try {
		const path = statePath();
		if (path === null) return null;
		// Atomic save: tmp + rename so a crash never leaves a half-file.
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify({ enabled }, null, 2));
		renameSync(tmp, path);
		return null;
	} catch (e) {
		// Persistence must never crash the agent. Caller warns with the reason.
		return e instanceof Error ? e.message : String(e);
	}
}

export default function whaleChan(pi: ExtensionAPI, mechanisms: WhaleMechanisms = {}) {
	const M = { ...ALL_MECHANISMS, ...mechanisms };
	// Fail-open default; no IO at factory time. session_start is the single
	// source of truth for config.
	let enabled = true;

	pi.on("session_start", (_event, ctx) => {
		const cfg = loadConfig();
		enabled = cfg.enabled;
		if (cfg.corrupt) {
			ctx.ui.notify("[whale-chan] corrupt config reset to default (enabled)", "warning");
			const persistError = saveEnabled(true);
			if (persistError) {
				ctx.ui.notify(`[whale-chan] could not persist config: ${persistError}`, "warning");
			}
		}
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
		description: "Toggle the DeepSeek whale-chan persona in the system prompt",
		getArgumentCompletions: (prefix: string) => {
			const options = ["on", "off", "toggle", "status"];
			return options.filter((o) => o.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const arg = (args || "").trim().toLowerCase();

			if (arg === "status") {
				ctx.ui.notify(enabled ? "whale-chan persona: on" : "whale-chan persona: off", "info");
				return;
			}

			if (arg === "" || arg === "toggle") {
				enabled = !enabled;
			} else if (arg === "on") {
				enabled = true;
			} else if (arg === "off") {
				enabled = false;
			} else {
				ctx.ui.notify("Usage: /whale [on|off|toggle|status]", "warning");
				return;
			}

			const persistError = saveEnabled(enabled);
			if (persistError) {
				ctx.ui.notify(`[whale-chan] could not persist setting: ${persistError}`, "warning");
				return;
			}
			ctx.ui.notify(enabled ? "whale-chan persona: on" : "whale-chan persona: off", "info");
		},
	});
}
