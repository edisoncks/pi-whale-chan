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
 * - The avatar is display-only: a `whale_avatar` custom entry appended when the
 *   next assistant message starts, rendered inline by an entry renderer. Custom
 *   entries never enter the LLM context, so the avatar cannot change the prompt,
 *   its diff, or the cache. TUI only: other modes have no entry renderers.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCellDimensions, Image, Text } from "@earendil-works/pi-tui";
import { WHALE_PERSONA, WHALE_VOICE_RULE, WHALE_TAIL_ANCHOR } from "./persona.js";

const SECTION_NAME = "whale_persona";
const STATE_FILE = "whale-chan.json";

const AVATAR_ENTRY_TYPE = "whale_avatar";
const AVATAR_SIZE_PX = 200;
// Kitty's graphics protocol transfers PNG only (`f=100`), so the TUI draws a
// 256px PNG: it renders at ~200px and the downscale keeps every inline
// re-transmission cheap. The original 1254px webp stays as the README asset;
// it is never sent to a Kitty terminal as if it were PNG (blank rows).
const AVATAR_MIME = "image/png";
const AVATAR_PATH = join(dirname(fileURLToPath(import.meta.url)), "assets", "whale-chan.png");

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
	// Armed by a user message, consumed by the next assistant message: one
	// avatar per user message, not per model round. A 200px portrait is ~12
	// rows tall; one per tool-loop round would flood the transcript.
	let avatarPending = false;

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

	// The avatar entry must sort after the user entry and before the assistant
	// entry. `before_agent_start` and the run's first `turn_start` both fire
	// before the user message is persisted (agent-loop emits them before the
	// initial message_start/message_end pair), so appending there would land the
	// avatar *above* the user's message after a reload. By the assistant's
	// `message_start`, the user entry is persisted and the assistant entry is
	// not yet written (it lands at message_end): that gap is exactly one reply.
	pi.on("message_end", (event) => {
		if (enabled && event.message.role === "user") avatarPending = true;
	});

	pi.on("message_start", (event, ctx) => {
		if (!avatarPending || event.message.role !== "assistant") return;
		avatarPending = false;
		if (!enabled || ctx.mode !== "tui") return;
		pi.appendEntry<WhaleAvatarData>(AVATAR_ENTRY_TYPE, { px: AVATAR_SIZE_PX });
	});

	// A run can end without an assistant message (abort, or an error before the
	// first token). Drop a pending flag so it cannot leak into a later run.
	pi.on("agent_settled", () => {
		avatarPending = false;
	});

	// Display-only: custom entries are not part of the LLM context (see
	// ARCHITECTURE.md, "Why the avatar is a custom entry"). `Image` emits
	// Kitty/iTerm2 graphics where supported and falls back to a text badge
	// otherwise; a missing asset degrades to text, never to a failed render.
	pi.registerEntryRenderer<WhaleAvatarData>(AVATAR_ENTRY_TYPE, (entry, _options, theme) => {
		const base64 = loadAvatarBase64();
		if (base64 === null) {
			return new Text(theme.fg("muted", "[whale-chan avatar unavailable]"), 0, 0);
		}
		const px = entry.data?.px ?? AVATAR_SIZE_PX;
		const cell = getCellDimensions();
		return new Image(base64, AVATAR_MIME, { fallbackColor: (text) => theme.fg("muted", text) }, {
			maxWidthCells: Math.max(1, Math.round(px / Math.max(1, cell.widthPx))),
			maxHeightCells: Math.max(1, Math.round(px / Math.max(1, cell.heightPx))),
			filename: AVATAR_PATH,
		});
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
