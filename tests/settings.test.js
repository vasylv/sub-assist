// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/settings.js");
const S = globalThis.EnHintSettings;

test("empty storage gives the defaults", () => {
  assert.deepEqual(S.normalise({}), { ...S.DEFAULTS });
  assert.deepEqual(S.normalise(undefined), { ...S.DEFAULTS });
});

test("null, empty string and non-numeric values fall back to the default, not 0 or NaN", () => {
  for (const bad of [null, undefined, "", "abc", NaN, Infinity]) {
    const r = S.normalise({ targetLines: bad, contextSeconds: bad });
    assert.equal(r.targetLines, S.DEFAULTS.targetLines, String(bad));
    assert.equal(r.contextSeconds, S.DEFAULTS.contextSeconds, String(bad));
  }
});

test("numbers are rounded and clamped to LIMITS", () => {
  assert.equal(S.normalise({ targetLines: 0 }).targetLines, 1);
  assert.equal(S.normalise({ targetLines: 999 }).targetLines, 12);
  assert.equal(S.normalise({ targetLines: "4.6" }).targetLines, 5);
  assert.equal(S.normalise({ contextSeconds: -5 }).contextSeconds, 0);
  assert.equal(S.normalise({ contextSeconds: 500 }).contextSeconds, 60);
});

test("zero context seconds is a legal value and is kept", () => {
  assert.equal(S.normalise({ contextSeconds: 0 }).contextSeconds, 0);
  assert.equal(S.normalise({ contextSeconds: "0" }).contextSeconds, 0);
});

test("blank prompt sections and model fall back to defaults", () => {
  const r = S.normalise({ divideRules: "   \n", groupingExamples: " ", explainRules: "", model: "  " });
  assert.equal(r.divideRules, S.DEFAULT_DIVIDE_RULES);
  assert.equal(r.groupingExamples, S.DEFAULT_GROUPING_EXAMPLES);
  assert.equal(r.explainRules, S.DEFAULT_EXPLAIN_RULES);
  assert.equal(r.model, S.DEFAULTS.model);
});

test("strings are trimmed", () => {
  const r = S.normalise({ apiKey: "  sk-x ", model: " m ", divideRules: "  hi  ", explainRules: " yo\n" });
  assert.equal(r.apiKey, "sk-x");
  assert.equal(r.model, "m");
  assert.equal(r.divideRules, "hi");
  assert.equal(r.explainRules, "yo");
});

test("unknown stored keys do not leak into the result", () => {
  const r = S.normalise({ "explain:abc:1:x": [1], level: "C1", prompt: "old free-form prompt" });
  assert.deepEqual(Object.keys(r).sort(), Object.keys(S.DEFAULTS).sort());
});

test("read() requests only the settings keys and normalises the result", async () => {
  let asked;
  globalThis.chrome = {
    storage: { local: { get: async (keys) => ((asked = keys), { targetLines: "50", divideRules: "" }) } },
  };
  const r = await S.read();
  assert.deepEqual(asked, Object.keys(S.DEFAULTS));
  assert.equal(r.targetLines, 12);
  assert.equal(r.divideRules, S.DEFAULT_DIVIDE_RULES);
});

test("font size is clamped and falls back like the other numbers", () => {
  assert.equal(S.normalise({}).fontSize, S.DEFAULTS.fontSize);
  assert.equal(S.normalise({ fontSize: "" }).fontSize, S.DEFAULTS.fontSize);
  assert.equal(S.normalise({ fontSize: 2 }).fontSize, S.LIMITS.fontSize.min);
  assert.equal(S.normalise({ fontSize: 99 }).fontSize, S.LIMITS.fontSize.max);
  assert.equal(S.normalise({ fontSize: "17.4" }).fontSize, 17);
});

test("font family is trimmed, and empty means YouTube's font", () => {
  assert.equal(S.normalise({}).fontFamily, "");
  assert.equal(S.normalise({ fontFamily: "   " }).fontFamily, "");
  assert.equal(S.normalise({ fontFamily: '  Georgia,   "Times New Roman", serif ' }).fontFamily, 'Georgia, "Times New Roman", serif');
});

test("font family cannot close the CSS declaration it is written into", () => {
  const r = S.normalise({ fontFamily: "Arial; } body { display:none } <x>\\" });
  assert.doesNotMatch(r.fontFamily, /[;{}<>\\]/);
  assert.ok(S.normalise({ fontFamily: "a".repeat(500) }).fontFamily.length <= 200);
});

test("a section saved at an earlier default is read as today's default", () => {
  // The defaults this version replaced, exactly as an untouched Save stored them.
  const oldDivide = [
    "- Prefer natural units of meaning: idioms, phrasal verbs, common expressions, meaningful phrases, or individual words.",
    "- Keep words together when their combined meaning is more useful than their separate meanings. For example, explain “give up” as one part.",
    "- Do not group an entire sentence into one part if smaller meaningful parts would help the learner.",
    "- Cover every word in its original order, including articles, pronouns, auxiliary verbs, prepositions, conjunctions, fillers, and repetitions.",
    "- Small grammatical words can belong to a larger phrase, but explain their role when it matters to understanding.",
    "- Each word must belong to exactly one part. Do not skip or duplicate words.",
    "- Keep punctuation attached to the relevant part; it does not need a separate explanation.",
    "- Caption line breaks may split a sentence or expression. Read all TARGET lines together before dividing them. If an expression spans lines, explain its combined meaning and identify the continuation.",
  ].join("\n");
  const r = S.normalise({ divideRules: oldDivide, explainRules: "- my own rule" });
  assert.equal(r.divideRules, S.DEFAULT_DIVIDE_RULES);
  assert.equal(r.explainRules, "- my own rule");
});

test("grouping examples keep their inner indentation", () => {
  assert.ok(S.DEFAULT_GROUPING_EXAMPLES.includes("\n  → “I was wondering” / “if you could give me a hand.”"));
  const own = "- “a lot of” → one part.\n  → not “a” / “lot of”";
  assert.equal(S.normalise({ groupingExamples: `\n${own}\n\n` }).groupingExamples, own);
});
