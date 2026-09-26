import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../eval/run.ts", import.meta.url));

test("eval runner rejects a missing value before the next option", () => {
	const result = spawnSync(process.execPath, [runner, "--model", "--repeat", "2"], {
		encoding: "utf8",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Error: missing value for --model/);
	assert.doesNotMatch(result.stderr, /model not found: --repeat/);
});
