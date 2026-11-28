// Pure helpers for the service worker, kept free of chrome APIs so they can be
// tested outside the extension.

// The whole prompt, as one message. Only {{divide}}, {{grouping}} and
// {{explain}} come from the viewer's settings. Everything else is fixed, and the OUTPUT FORMAT most
// of all: parseExplanation() below reads exactly that format.
//
// {{captionNote}} is the one part that depends on the video: whether the track
// the player downloaded is machine-generated. Nobody can know that when writing
// a setting, so it is filled per request — and is empty for human captions.
export const PROMPT_TEMPLATE = `You help an English learner understand subtitle and caption lines by breaking them into meaningful phrases and explaining them in simple English.

INPUT
- TARGET: The caption lines to explain.
- CONTEXT: Optional earlier lines that help determine meaning.

TASK
Explain every TARGET line. Cover all its words, while grouping them into natural units of meaning.

HOW TO DIVIDE THE TEXT
{{divide}}

GROUPING EXAMPLES
{{grouping}}

HOW TO EXPLAIN
{{explain}}

{{captionNote}}OUTPUT FORMAT
- “[exact part]” → [simple explanation of its meaning here]
- “[next exact part]” → [simple explanation]
- Continue until all words are covered.


FINAL CHECK
Before responding, verify that:
- Every TARGET word appears exactly once in the quoted parts, in the original order.
- Pronouns and connecting words remain attached to meaningful phrases.
- Idioms and other expressions are not split in ways that hide their meaning.
- Every explanation matches the context.
- Only TARGET lines are explained.

CONTEXT:
{{context}}

TARGET:
{{target}}`;

// Every word has to be covered, so a mishearing cannot simply be skipped; the
// note asks for it to be flagged instead.
export const AUTO_CAPTIONS_NOTE = `CAPTIONS
- These captions are machine-generated: no punctuation, inconsistent casing, and words may be mis-transcribed. When a part looks like a mishearing, explain it as written and briefly name the likely intended words.

`;

// One pass over the template, so a placeholder that turns up inside a filled
// value — a viewer's rule, or a subtitle that happens to say "{{target}}" — is
// left as text rather than substituted again.
export function buildPrompt({ divideRules, groupingExamples, explainRules }, { target, context, auto }) {
  const values = {
    divide: divideRules,
    grouping: groupingExamples,
    explain: explainRules,
    captionNote: auto ? AUTO_CAPTIONS_NOTE : "",
    context: context && context.length ? context.map((c) => c.text).join("\n") : "(none)",
    // Numbered 1..n so the model can name the lines a grouped phrase spans.
    target: target.map((c, i) => `${i + 1}. ${c.text}`).join("\n"),
  };
  return PROMPT_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

// --- reading the reply --------------------------------------------------------
// The model is asked for a flat list of "- “part” → explanation" rows, and
// mostly keeps to it, but it is free text: bold markers, straight quotes,
// "->" for the arrow, a missing bullet or the placeholder's [brackets] all
// turn up. A line that is not a row continues the row
// above it; text before the first row is kept as a note. So nothing the model
// said is dropped. If there is no row at all, the reply is returned whole as
// `raw` and the card shows it as it came.

const unquote = (s) =>
  s
    .trim()
    .replace(/^["“”']+|["“”']+$/g, "")
    .trim();
const unbold = (s) => s.replace(/\*\*/g, "").replace(/^#+\s*/, "");

// The format's placeholders are “[exact part]” and [explanation], and a model
// sometimes copies the brackets along with the words. Only a value wrapped
// whole in one pair is unwrapped, so "[sic]" inside an explanation survives.
const unbracket = (s) => s.replace(/^\[([^[\]]*)\]$/, "$1").trim();

// A row is "- “part” → explanation". The bullet is sometimes dropped (or
// becomes "1."), so a row without one is accepted too — but only when its left
// side is quoted, so ordinary prose that happens to hold an arrow stays prose.
const BULLETED_RE = /^(?:[-*•]|\d+[.)])\s*(.+?)\s*(?:→|->|=>)\s*(.+)$/;
const BARE_RE = /^(["“].+?["”](?:\s*(?:\([^)]*\)|\[[^\]]*\]))?)\s*(?:→|->|=>)\s*(.+)$/;
const GROUPED_RE = /^["“](.+)["”]\s*(\(.*\)|\[.*\])$/;

export function parseExplanation(text) {
  const parts = [];
  const notes = [];
  let part = null;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const row = unbold(rawLine).trim();
    if (!row) continue;

    const m = row.match(BULLETED_RE) || row.match(BARE_RE);
    if (m) {
      // A phrase grouped across caption lines comes with a note on which ones:
      // “if you could / give me a hand” (lines 2–3). The note is kept apart so
      // the quoted words stay exactly the words that were said.
      const g = m[1].match(GROUPED_RE);
      const explanation = unbracket(m[2].trim());
      part = g
        ? { part: unbracket(g[1].trim()), where: g[2].replace(/^[([]|[)\]]$/g, "").trim(), explanation }
        : { part: unbracket(unquote(m[1])), explanation };
      parts.push(part);
    } else if (part) {
      part.explanation += " " + row.replace(/^[-*•]\s*/, "");
    } else {
      notes.push(row);
    }
  }

  return parts.length ? { parts, notes } : { raw: String(text || "").trim() };
}
