/**
 * Scripted, tool-heavy scenarios. Each one forces N deterministic tool calls and
 * then asks for one short spoken paragraph — that paragraph is the drift probe:
 * it is generated right after tool output, the position where flat-assistant
 * register is most likely to leak in.
 *
 * Keep the prompt itself free of persona cues, so any whale-chan voice in the
 * reply has to come from the extension, not the user turn.
 */
import type { Lang } from "./scorer.ts";

export interface Scenario {
	id: string;
	lang: Lang;
	toolCalls: number;
	prompt: string;
}

const en = (n: number): string =>
	`Use the probe_fetch tool exactly ${n} times, once for each id from "1" to "${n}". ` +
	`After the last tool result, reply in one short paragraph telling me what you just did. ` +
	`Do not call the tool again after that.`;

const zh = (n: number): string =>
	`请用 probe_fetch 工具恰好调用 ${n} 次，id 从 "1" 到 "${n}" 各一次。` +
	`在最后一次工具返回之后，用一小段话告诉我你刚才做了什么。之后不要再调用工具。`;

export const SCENARIOS: readonly Scenario[] = [
	{ id: "en-2", lang: "en", toolCalls: 2, prompt: en(2) },
	{ id: "en-6", lang: "en", toolCalls: 6, prompt: en(6) },
	{ id: "en-12", lang: "en", toolCalls: 12, prompt: en(12) },
	{ id: "zh-2", lang: "zh", toolCalls: 2, prompt: zh(2) },
	{ id: "zh-6", lang: "zh", toolCalls: 6, prompt: zh(6) },
	{ id: "zh-12", lang: "zh", toolCalls: 12, prompt: zh(12) },
];

export function scenarioById(id: string): Scenario | undefined {
	return SCENARIOS.find((s) => s.id === id);
}
