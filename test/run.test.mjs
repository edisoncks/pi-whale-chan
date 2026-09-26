import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("../eval/run.ts", import.meta.url));

function runRunner(...args) {
	return spawnSync(process.execPath, [runner, ...args], { encoding: "utf8" });
}

test("eval runner rejects a missing value before the next option", () => {
	const result = runRunner("--model", "--repeat", "2");

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Error: missing value for --model/);
	assert.doesNotMatch(result.stderr, /model not found: --repeat/);
});

test("eval runner rejects a missing value at end of argv", () => {
	const result = runRunner("--model");

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Error: missing value for --model/);
});

test("eval runner rejects unknown arguments", () => {
	const result = runRunner("--modle", "x");

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Error: unknown argument: --modle/);
});
