// Service worker: the only place the OpenAI key lives.
//
// Keeping the key here rather than in a content script matters — a content
// script shares a page with YouTube's own JavaScript, and anything it holds is
// one bug away from being reachable. The service worker has no DOM and no page.
//
// One small request per pause. Nothing is sent while the video simply plays:
// the viewer pressing pause IS the request, so there is nothing to predict and
// nothing to pay for on a video they understood.

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MAX_ITEMS = 6; // more than this on one pause is a wall, not an explanation

const DEFAULTS = {
  apiKey: "",
  model: "gpt-4.1-mini",
  level: "B1",
};

// Strict JSON schema — every property must be listed in `required` and
// additionalProperties must be false, or the API rejects it.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "kind", "meaning"],
        properties: {
          term: {
            type: "string",
            description: "The expression in its natural dictionary form, e.g. \"wing it\"",
          },
          kind: {
            type: "string",
            enum: ["idiom", "phrasal_verb", "word", "slang", "reference"],
          },
          meaning: {
            type: "string",
            description: "One or two short sentences of plain English at or below the learner's level",
          },
        },
      },
    },
  },
};

function systemPrompt(level, isAuto) {
  return [
    `You help a learner of English at CEFR level ${level} watch English-language video.`,
    "They have just paused. Explain what they heard.",
    "",
    "You are given TARGET lines — the lines they just heard — and sometimes CONTEXT",
    "lines from the ten seconds before them.",
    "",
    "In the TARGET lines, find:",
    "- idioms and phrasal verbs whose meaning is not the sum of their parts",
    `- single words a ${level} learner would not know`,
    "- cultural, historical or in-group references they may not recognise",
    "",
    "Rules:",
    "- Answer in English. Do not translate anything into any other language.",
    "- CONTEXT exists only so you read the TARGET lines correctly. Never return a term",
    "  that appears only in CONTEXT.",
    "- `term` is the expression in its natural dictionary form, not the inflected form",
    "  from the subtitle: \"go over someone's head\", not \"went over my head\".",
    "- `meaning` gives the sense it carries HERE, in one or two short sentences at or",
    `  below ${level}. Not a dictionary dump.`,
    `- Skip anything a ${level} learner already knows. An empty list is a good answer,`,
    "  and a much better one than padding.",
    isAuto
      ? "- These captions are machine-generated: no punctuation, inconsistent casing, and words may be mis-transcribed. Do not explain an obvious mishearing."
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

// The cue index alone is not the question. A line still playing is sent cut off
// at the playhead, so pausing early in it and pausing again at its end ask about
// different words — and the second must not be answered out of the first one's
// entry. The text itself goes into the key, condensed to keep the key short.
function fingerprint(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

const cacheKeyFor = (videoId, index, targetText, settings) =>
  `explain:${videoId}:${index}:${fingerprint(targetText)}:${settings.level}:${settings.model}`;

const asBlock = (label, lines) =>
  lines.length ? `${label}\n${lines.map((c) => `[${c.index}] ${c.text}`).join("\n")}` : "";

// The model is asked not to explain the context lines, and cannot be made to
// obey. So anything it returns is checked against the target text before it
// reaches the card.
//
// The check cannot be a plain substring match: `term` is deliberately in
// dictionary form, so "go over someone's head" will never appear verbatim in a
// line that says "went over my head". What does hold is that at least one
// distinctive word of a real term shows up in the target — "head" here, "wing"
// inside "winging" — while a term lifted out of the context has none.
const SKIP = new Set([
  "a", "an", "the", "to", "of", "in", "on", "at", "it", "its", "as", "so", "if",
  "one", "ones", "someone", "someones", "somebody", "something", "oneself",
  "your", "yours", "their", "theirs", "his", "her", "hers", "my", "mine", "our",
  "be", "is", "are", "was", "were", "been", "do", "does", "did", "have", "has",
  "and", "or", "for", "with", "that", "this", "you", "they", "not", "no",
]);

function groundedInTarget(term, targetText) {
  const tokens = term
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !SKIP.has(w));
  // Nothing distinctive to test — a single short word like "gig". Fall back to
  // the whole term, and keep it if even that is inconclusive.
  if (!tokens.length) return targetText.includes(term.toLowerCase());
  return tokens.some((w) => targetText.includes(w));
}

function clean(raw, targetText) {
  const seen = new Set();
  const out = [];

  for (const item of raw) {
    if (!item || typeof item.term !== "string" || typeof item.meaning !== "string") continue;
    const term = item.term.trim();
    const meaning = item.meaning.trim();
    if (!term || !meaning) continue;

    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    if (!groundedInTarget(term, targetText)) continue;

    seen.add(key);
    out.push({ term, kind: item.kind || "word", meaning });
    if (out.length === MAX_ITEMS) break;
  }
  return out;
}

async function explain({ videoId, index, target, context, auto }) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, error: "No OpenAI API key set. Open the extension options to add one." };
  }
  if (!Array.isArray(target) || !target.length) {
    return { ok: false, error: "nothing to explain here" };
  }

  const targetText = target.map((c) => c.text).join(" ");
  const cacheKey = cacheKeyFor(videoId, index, targetText, settings);
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) return { ok: true, items: cached, cached: true };

  const user = [asBlock("CONTEXT", context || []), asBlock("TARGET", target)]
    .filter(Boolean)
    .join("\n\n");

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: "system", content: systemPrompt(settings.level, auto) },
        { role: "user", content: user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "explanations", strict: true, schema: SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content");
  const items = clean(JSON.parse(content).items || [], targetText.toLowerCase());

  await chrome.storage.local.set({ [cacheKey]: items });
  return { ok: true, items, cached: false };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "explain") {
    explain(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the channel open for the async reply
  }
  return false;
});
