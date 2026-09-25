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
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WHALE_PERSONA } from "./persona.js";

const SECTION_NAME = "whale_persona";
const STATE_FILE = "whale-chan.json";

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

function saveEnabled(enabled: boolean): boolean {
	try {
		const path = statePath();
		if (path === null) return true;
		// Atomic save: tmp + rename so a crash never leaves a half-file.
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, JSON.stringify({ enabled }, null, 2));
		renameSync(tmp, path);
		return true;
	} catch {
		// Persistence must never crash the agent. Caller warns.
		return false;
	}
}

export default function whaleChan(pi: ExtensionAPI) {
	// Fail-open default; no IO at factory time. session_start is the single
	// source of truth for config.
	let enabled = true;

	pi.on("session_start", (_event, ctx) => {
		const cfg = loadConfig();
		enabled = cfg.enabled;
		if (cfg.corrupt) {
			const persisted = saveEnabled(true);
			ctx.ui.notify("[whale-chan] corrupt config reset to default (enabled)", "warning");
			if (!persisted) {
				ctx.ui.notify("[whale-chan] could not persist config (check agent dir permissions)", "warning");
			}
		}
	});

	// Section patch, not prompt replacement: Pi diffs sections and appends only
	// what changed. Re-setting an unchanged frozen string yields no diff.
	pi.on("before_agent_start", (event) => {
		if (enabled) {
			event.systemPromptOptions.sections[SECTION_NAME] = WHALE_PERSONA;
		} else {
			delete event.systemPromptOptions.sections[SECTION_NAME];
		}
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

			const persisted = saveEnabled(enabled);
			if (!persisted) {
				ctx.ui.notify("[whale-chan] could not persist setting (check agent dir permissions)", "warning");
				return;
			}
			ctx.ui.notify(enabled ? "whale-chan persona: on" : "whale-chan persona: off", "info");
		},
	});
}
