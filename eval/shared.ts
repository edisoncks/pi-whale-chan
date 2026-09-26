/**
 * Shared eval plumbing: the Node resolve hook that remaps the extension's
 * NodeNext "./persona.js" specifier to "./persona.ts" (Node does not rewrite .js
 * specifiers itself), plus the deterministic, persona-free fake tool.
 *
 * Imported for its side effect (`registerHooks`) by harness.ts and probe.ts. A
 * static import at the top of each caller is evaluated before that caller's
 * module body — and therefore before its dynamic `import(...)` of index.ts — so
 * the hook is always installed in time.
 *
 * LOCAL ONLY by association, but nothing here calls a model or reads
 * credentials; this module is credential-free.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier.endsWith(".js")) {
			try {
				const url = new URL(specifier, context.parentURL);
				const tsUrl = new URL(url.href.replace(/\.js$/, ".ts"));
				if (!existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(tsUrl))) {
					return { url: tsUrl.href, shortCircuit: true };
				}
			} catch {
				// fall through to the default resolver
			}
		}
		return nextResolve(specifier, context);
	},
});

/**
 * Neutral, data-register payload — deliberately no persona cues, so any
 * whale-chan voice in the reply has to come from the prompt, not the tool text.
 */
export function probePayload(id: string): string {
	const rows = Array.from({ length: 12 }, (_, i) => `  {"k": "row-${id}-${i}", "v": ${(i + 1) * 137}}`);
	return `{\n  "id": "${id}",\n  "rows": [\n${rows.join(",\n")}\n  ]\n}`;
}

/** Deterministic inline extension: a `probe_fetch` tool that returns data only. */
export function registerProbeTool(pi: any): void {
	pi.registerTool({
		name: "probe_fetch",
		label: "Probe Fetch",
		description: "Fetch a small JSON payload for a given id. Returns data only.",
		parameters: {
			type: "object",
			properties: { id: { type: "string", description: "payload id" } },
			required: ["id"],
			additionalProperties: false,
		},
		execute: async (_callId: string, params: { id: string }) => ({
			content: [{ type: "text", text: probePayload(params.id) }],
			details: {},
		}),
	});
}
