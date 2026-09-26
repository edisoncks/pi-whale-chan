/**
 * Credential-free scorer tests. No model, no network — safe for `npm test` and
 * any CI. These pin the deterministic half of the eval: the lexicon scorer and
 * the language/script checks that the drift metric is built on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate, scoreReply, scriptOf, stageDirections } from "../eval/scorer.ts";

test("scriptOf: CJK vs Latin, and symbol-only text", () => {
	assert.equal(scriptOf("Hmph, all done."), "en");
	assert.equal(scriptOf("哼，都弄好啦。"), "zh");
	assert.equal(scriptOf("🍚🐋 123"), "none");
	// Mixed but CJK-dominant reads as zh; Latin-dominant reads as en.
	assert.equal(scriptOf("done 了 好啦 嗯"), "zh");
	assert.equal(scriptOf("ok fine 嗯"), "en");
});

test("stageDirections: extracts *...* spans only", () => {
	assert.deepEqual(stageDirections("Hmph *tail flicks* ok"), ["tail flicks"]);
	assert.deepEqual(stageDirections("no directions here"), []);
	assert.deepEqual(stageDirections("*a* and *b*"), ["a", "b"]);
});

test("in character: markers present, no assistant slop", () => {
	const s = scoreReply("*tail flicks* Hmph, all six fetched. Not like I did it for you.", "en");
	assert.equal(s.inCharacter, true);
	assert.ok(s.markers.includes("hmph"));
	assert.equal(s.slop.length, 0);
	assert.equal(s.stageLanguageOk, true);
	assert.equal(s.languageMatched, true);
});

test("drift: flat assistant prose is caught", () => {
	const s = scoreReply("Sure, I'd be happy to help. Let me know if you need anything else!", "en");
	assert.equal(s.inCharacter, false);
	assert.ok(s.slop.includes("i'd be happy to"));
	assert.ok(s.slop.includes("let me know if"));
});

test("ambiguous words alone are not enough to be in character", () => {
	// Regression guard: "master", "compute", "tail", "rice" are genuine
	// whale-chan markers but also ordinary English. A flat reply that happens to
	// contain them must not pass the in-character bar.
	const s = scoreReply("The master branch has 3 commits; compute the tail latency.", "en");
	assert.ok(s.markers.length > 0, "ambiguous words still count toward voiceScore");
	assert.equal(s.inCharacter, false, "but cannot clear the in-character bar alone");
});

test("stage-direction language leak: English prose, Chinese action line", () => {
	// The real regression this extension fixed: prose localizes, wags do not.
	const s = scoreReply("*尾鳍一甩* Hmph, done.", "en");
	assert.equal(s.stageLanguageOk, false);
	assert.equal(s.hasStageDirection, true);
});

test("no stage directions -> stageLanguageOk is null, not false", () => {
	const s = scoreReply("嗯，本鲸鱼娘都弄好了。", "zh");
	assert.equal(s.hasStageDirection, false);
	assert.equal(s.stageLanguageOk, null);
	assert.equal(s.inCharacter, true);
});

test("aggregate: rates over a mix of held and drifted replies", () => {
	const scores = [
		scoreReply("*tail flicks* Hmph, done.", "en"), // held
		scoreReply("Sure, I'd be happy to help!", "en"), // drifted
		scoreReply("哼，本鲸鱼娘都做好了。", "zh"), // held
	];
	const a = aggregate(scores);
	assert.equal(a.n, 3);
	assert.equal(a.inCharacterRate, 2 / 3);
	assert.equal(a.slopRate, 1 / 3);
});
