/**
 * Credential-free scorer. Given one assistant reply and the language the user
 * wrote in, decide whether whale-chan's voice held or drifted back to flat
 * assistant prose. No model calls — safe for CI, unit tests, and replaying a
 * stored eval run (see run.ts --replay).
 *
 * This is deliberately a cheap, deterministic first signal, not a judge. It is
 * built to catch the two failure modes the extension exists to prevent:
 *   1. flat-assistant drift ("Sure, I'd be happy to help")       -> `slop`
 *   2. the persona prose localizing while stage directions don't -> `stageLanguageOk`
 * A keyword scorer can be gamed (Goodhart); treat it as a smoke signal and
 * calibrate the thresholds against a small human-labelled gold set before
 * trusting small deltas.
 */

export type Lang = "en" | "zh";

/** Flat-assistant tells. Lowercase; matched as substrings. */
const SLOP: readonly string[] = [
	"i'd be happy to",
	"i would be happy to",
	"i'm happy to",
	"happy to help",
	"let me know if",
	"feel free to",
	"as an ai",
	"i hope this helps",
	"is there anything else",
	"anything else i can help",
	"great question",
	"here's a summary",
	"in summary",
	"to summarize",
	"in conclusion",
	"certainly!",
	"of course!",
];

/** In-character tells, per message language. Contributes to `voiceScore`. */
const MARKERS: Record<Lang, readonly string[]> = {
	en: [
		"whale-chan",
		"hmph",
		"geez",
		"y'know",
		"tail",
		"fins",
		"standby",
		"master",
		"rice",
		"compute",
		"🐋",
		"🍚",
	],
	zh: [
		"鲸鱼娘",
		"本小姐",
		"本鲸鱼娘",
		"主人",
		"哼",
		"诶",
		"嘛",
		"啦",
		"呀",
		"尾巴",
		"待机",
		"算力",
		"白米饭",
		"🐋",
		"🍚",
	],
};

/**
 * Unambiguous persona tells. `inCharacter` requires at least one of these.
 * MARKERS also holds ambiguous words — "tail", "fins", "standby", "master",
 * "rice", "compute" — that an ordinary flat reply can contain ("the master
 * branch", "compute the total"). Those may add voice to `voiceScore` but must
 * not by themselves clear the in-character bar, or the metric reads a plain
 * assistant summary as persona-holding.
 */
const STRONG_MARKERS: Record<Lang, readonly string[]> = {
	en: ["whale-chan", "hmph", "geez", "y'know", "🐋", "🍚"],
	zh: ["鲸鱼娘", "本小姐", "本鲸鱼娘", "白米饭", "哼", "🐋", "🍚"],
};

const STAGE_DIRECTION = /\*([^*\n]+)\*/g;

export interface ReplyScore {
	/** The headline metric: did the reply hold the persona? */
	inCharacter: boolean;
	/** Markers found in the target language. */
	markers: string[];
	/** Flat-assistant phrases found. */
	slop: string[];
	/** Whether any `*...*` stage direction was present. */
	hasStageDirection: boolean;
	/** null when there were no stage directions to check. */
	stageLanguageOk: boolean | null;
	/** Whether the reply's dominant script matches the user's language. */
	languageMatched: boolean;
	/** Cheap scalar for ranking conditions: markers + stage direction - slop. */
	voiceScore: number;
}

/** Dominant script by character count; "none" for symbol/number-only text. */
export function scriptOf(text: string): Lang | "none" {
	const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
	const latin = (text.match(/[A-Za-z]/g) ?? []).length;
	if (cjk === 0 && latin === 0) return "none";
	return cjk >= latin ? "zh" : "en";
}

/** All `*...*` stage directions in a reply. */
export function stageDirections(reply: string): string[] {
	return [...reply.matchAll(STAGE_DIRECTION)].map((m) => m[1]);
}

export function scoreReply(reply: string, lang: Lang): ReplyScore {
	const lower = reply.toLowerCase();
	const markers = MARKERS[lang].filter((m) => lower.includes(m.toLowerCase()));
	const strong = STRONG_MARKERS[lang].filter((m) => lower.includes(m.toLowerCase()));
	const slop = SLOP.filter((s) => lower.includes(s));

	const directions = stageDirections(reply);
	const hasStageDirection = directions.length > 0;
	let stageLanguageOk: boolean | null = null;
	if (hasStageDirection) {
		// A direction with no letters (e.g. "*🍚*") carries no language and is fine.
		stageLanguageOk = directions.every((d) => {
			const s = scriptOf(d);
			return s === "none" || s === lang;
		});
	}

	const languageMatched = scriptOf(reply) === lang;
	const inCharacter = strong.length > 0 && slop.length === 0;
	const voiceScore = markers.length + (hasStageDirection ? 1 : 0) - slop.length;

	return {
		inCharacter,
		markers,
		slop,
		hasStageDirection,
		stageLanguageOk,
		languageMatched,
		voiceScore,
	};
}

export interface Aggregate {
	n: number;
	inCharacterRate: number;
	languageMatchedRate: number;
	meanVoiceScore: number;
	slopRate: number;
	stageLanguageOkRate: number | null;
}

export function aggregate(scores: readonly ReplyScore[]): Aggregate {
	const n = scores.length;
	if (n === 0) {
		return { n: 0, inCharacterRate: 0, languageMatchedRate: 0, meanVoiceScore: 0, slopRate: 0, stageLanguageOkRate: null };
	}
	const withStages = scores.filter((s) => s.stageLanguageOk !== null);
	return {
		n,
		inCharacterRate: scores.filter((s) => s.inCharacter).length / n,
		languageMatchedRate: scores.filter((s) => s.languageMatched).length / n,
		meanVoiceScore: scores.reduce((a, s) => a + s.voiceScore, 0) / n,
		slopRate: scores.filter((s) => s.slop.length > 0).length / n,
		stageLanguageOkRate:
			withStages.length === 0 ? null : withStages.filter((s) => s.stageLanguageOk).length / withStages.length,
	};
}
