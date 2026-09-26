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

test("eval runner rejects a non-integer repeat", () => {
	for (const raw of ["2.5", "3abc", "0"]) {
		const result = runRunner("--repeat", raw);

		assert.notEqual(result.status, 0);
		assert.match(result.stderr, new RegExp(`Error: --repeat must be a positive integer, got: ${raw}`));
	}
});

test("eval runner rejects an unknown thinking level", () => {
	const result = runRunner("--thinking", "bogus");

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Error: --thinking must be one of: off, low, medium, high, got: bogus/);
});

test("eval runner rejects unknown conditions before any model call", () => {
	const result = runRunner("--conditions", "full,bogus");

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Error: unknown condition: bogus/);
});

test("eval runner rejects unknown scenarios before any model call", () => {
	const result = runRunner("--scenarios", "bogus");

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Error: unknown scenario: bogus/);
});
