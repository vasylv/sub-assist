// Run with: node --test tests/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/settings.js");
const S = globalThis.EnHintSettings;

let core;
test.before(async () => {
  core = await import("../src/explain-core.js");
});

const rules = {
  divideRules: S.DEFAULT_DIVIDE_RULES,
  groupingExamples: S.DEFAULT_GROUPING_EXAMPLES,
  explainRules: S.DEFAULT_EXPLAIN_RULES,
};
const cue = (text) => ({ text });

test("rules, context and target all change the built prompt", () => {
  const input = { target: [cue("went over")], context: [], auto: false };
  const p = core.buildPrompt(rules, input);
  assert.notEqual(p, core.buildPrompt(rules, { ...input, target: [cue("went over my head")] }));
  assert.notEqual(p, core.buildPrompt(rules, { ...input, context: [cue("earlier")] }));
  assert.notEqual(p, core.buildPrompt({ ...rules, explainRules: "- be brief" }, input));
  assert.notEqual(p, core.buildPrompt({ ...rules, divideRules: "- by word" }, input));
  assert.notEqual(p, core.buildPrompt({ ...rules, groupingExamples: "- “a b” → one part." }, input));
});

// --- building the prompt -----------------------------------------------------

test("the editable sections land under their fixed headings", () => {
  const p = core.buildPrompt(
    { divideRules: "- DIVIDE RULE", groupingExamples: "- GROUPING EXAMPLE", explainRules: "- EXPLAIN RULE" },
    { target: [cue("a")], context: [] },
  );
  assert.match(p, /HOW TO DIVIDE THE TEXT\n- DIVIDE RULE\n\nGROUPING EXAMPLES\n- GROUPING EXAMPLE\n\nHOW TO EXPLAIN\n/);
  assert.match(p, /HOW TO EXPLAIN\n- EXPLAIN RULE\n\nOUTPUT FORMAT\n/);
  assert.ok(p.startsWith("You help an English learner understand subtitle and caption lines by breaking"));
  assert.doesNotMatch(p, /\{\{/);
});

test("the default prompt is the one asked for, word for word", () => {
  const p = core.buildPrompt(rules, { target: [cue("x")], context: [] });
  assert.ok(p.includes("- Read all TARGET lines and available CONTEXT before dividing the text."));
  assert.ok(p.includes("such as “give up,” “by the way,” or “out of the blue.”"));
  assert.ok(p.includes("- Explain each part’s meaning in this specific context"));
  assert.ok(p.includes("GROUPING EXAMPLES\n- “I was wondering” → one part.\n"));
  assert.ok(p.includes("Keep fillers such as “well,” “like,” and “you know” with a neighboring phrase"));
  assert.ok(p.includes("- Every TARGET word appears exactly once in the quoted parts, in the original order."));
});

test("target lines are numbered 1..n and context is listed plainly", () => {
  const p = core.buildPrompt(rules, { target: [cue("first"), cue("second")], context: [cue("before")] });
  assert.ok(p.endsWith("CONTEXT:\nbefore\n\nTARGET:\n1. first\n2. second"));
});

test("no context is said, not left blank", () => {
  const p = core.buildPrompt(rules, { target: [cue("x")], context: [] });
  assert.ok(p.includes("CONTEXT:\n(none)\n\nTARGET:"));
});

test("the captions note appears only for auto captions, before OUTPUT FORMAT", () => {
  const input = { target: [cue("x")], context: [] };
  assert.ok(!core.buildPrompt(rules, { ...input, auto: false }).includes("machine-generated"));
  const auto = core.buildPrompt(rules, { ...input, auto: true });
  assert.ok(auto.includes(core.AUTO_CAPTIONS_NOTE + "OUTPUT FORMAT\n"));
});

test("a placeholder inside a subtitle or a rule is not substituted again", () => {
  const p = core.buildPrompt(
    { divideRules: "- see {{target}}", groupingExamples: "- {{grouping}}", explainRules: "- x" },
    { target: [cue("say {{context}}")], context: [cue("ctx")] },
  );
  assert.ok(p.includes("- see {{target}}"));
  assert.ok(p.includes("- {{grouping}}"));
  assert.ok(p.endsWith("1. say {{context}}"));
});

// --- parsing the reply -------------------------------------------------------

test("a reply in the requested format becomes a list of parts", () => {
  const r = core.parseExplanation(`- “I was wondering” → a polite way to start a request.
- “if you could give me a hand.” → if you could help me.
- "by the way" -> used to add a new topic.`);
  assert.deepEqual(r, {
    notes: [],
    parts: [
      { part: "I was wondering", explanation: "a polite way to start a request." },
      { part: "if you could give me a hand.", explanation: "if you could help me." },
      { part: "by the way", explanation: "used to add a new topic." },
    ],
  });
});

test("markdown bold and a preamble are tolerated", () => {
  const r = core.parseExplanation(`Here is the breakdown:

- **“wing it”** → improvise.`);
  assert.deepEqual(r.notes, ["Here is the breakdown:"]);
  assert.deepEqual(r.parts, [{ part: "wing it", explanation: "improvise." }]);
});

test("a phrase grouped across lines keeps its line note in the part", () => {
  const r = core.parseExplanation("- “if you could / give me a hand” (lines 2–3) → if you could help me.");
  assert.deepEqual(r.parts[0], {
    part: "if you could / give me a hand",
    where: "lines 2–3",
    explanation: "if you could help me.",
  });
});

test("a wrapped explanation continues the part above it", () => {
  const r = core.parseExplanation(`- “and then” → after that.
  It links to the next line.
- “she left” → she went away.`);
  assert.equal(r.parts[0].explanation, "after that. It links to the next line.");
  assert.equal(r.parts.length, 2);
});

test("a reply that ignores the format comes back whole as raw", () => {
  assert.deepEqual(core.parseExplanation("  Sorry, I can't help.  "), { raw: "Sorry, I can't help." });
  assert.deepEqual(core.parseExplanation(""), { raw: "" });
  assert.deepEqual(core.parseExplanation(undefined), { raw: "" });
});

test("rows without a bullet, with the placeholder's brackets copied, still parse", () => {
  const r = core.parseExplanation(`“[looking at agents and our content in a]” → examining or considering both support agents and our content materials as part of a

“[life]” → this is likely a machine-generated mishearing (transcription error)`);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(
    r.parts.map((p) => p.part),
    ["looking at agents and our content in a", "life"],
  );
  assert.equal(r.parts[1].explanation, "this is likely a machine-generated mishearing (transcription error)");
});

test("bracketed explanations, numbered rows and bracketed grouped parts are unwrapped", () => {
  const r = core.parseExplanation(`1. “[and then]” → [after that.]
“[if you could / give me a hand]” (lines 2–3) → if you could help me [sic].`);
  assert.deepEqual(r.parts[0], { part: "and then", explanation: "after that." });
  assert.deepEqual(r.parts[1], {
    part: "if you could / give me a hand",
    where: "lines 2–3",
    explanation: "if you could help me [sic].",
  });
});

test("unquoted prose with an arrow is not mistaken for a row", () => {
  const r = core.parseExplanation("The speaker moves from A -> B here.");
  assert.deepEqual(r, { raw: "The speaker moves from A -> B here." });
});
