// The settings, in one place.
//
// Three separate contexts read these: the service worker (which owns the key and
// the prompt), the options page (which writes them), and the content script
// (which decides how many lines to send). They used to keep their own copies of
// the defaults, which is fine until the copies disagree.
//
// The service worker is an ES module and the other two are classic scripts, so
// the binding is published on globalThis rather than exported — a bare
// `EnHintSettings` then resolves in all three.

const EnHintSettings = (() => {
  // The prompt is fixed except for three sections: the rules for dividing a
  // line into parts, the grouping examples that show those rules at work, and
  // the rules for explaining the parts. Those are the viewer's to tune;
  // everything else — the task, the input blocks and above all the OUTPUT
  // format — is fixed in src/explain-core.js, because the card parses that
  // format and would break if it were edited.
  const DEFAULT_DIVIDE_RULES = [
    "- Read all TARGET lines and available CONTEXT before dividing the text.",
    "- Divide by meaning: use idioms, phrasal verbs, common expressions, and natural phrases.",
    "- Keep expressions together when their combined meaning matters, such as \u201cgive up,\u201d \u201cby the way,\u201d or \u201cout of the blue.\u201d",
    "- Keep pronouns, articles, auxiliary verbs, prepositions, and connecting words attached to the phrase they support. Do not make them separate parts.",
    "- Use a single word as a part only when it carries an independent meaning and does not naturally belong to a neighboring phrase.",
    "- Avoid both excessive splitting and overly broad grouping. Each part should express one useful idea for the learner.",
    "- Do not treat a whole sentence as one part when it contains several useful phrases. A short sentence expressing one idea can remain together.",
    "- Include every word exactly once, in its original order. Full coverage means including every word within a part; it does not mean explaining each word individually.",
    "- Preserve the original wording, contractions, repetitions, and punctuation in the quoted parts. Punctuation does not need a separate explanation.",
  ].join("\n");

  // Worked examples of the dividing rules. Indentation inside is kept: the last
  // example continues onto an indented "→" line.
  const DEFAULT_GROUPING_EXAMPLES = [
    "- \u201cI was wondering\u201d \u2192 one part.",
    "- \u201cbut at the same time\u201d \u2192 one part.",
    "- \u201cif you think about it\u201d \u2192 one part.",
    "- \u201cshe gave up\u201d \u2192 one part.",
    "- \u201cI was wondering if you could give me a hand.\u201d",
    "  \u2192 \u201cI was wondering\u201d / \u201cif you could give me a hand.\u201d",
  ].join("\n");

  const DEFAULT_EXPLAIN_RULES = [
    "- Explain each part\u2019s meaning in this specific context using simple, natural English.",
    "- Explain the phrase as a whole rather than giving a word-by-word definition.",
    "- For idioms, slang, and figurative expressions, explain the intended meaning. Add the literal meaning only when it helps.",
    "- Do not label an ordinary phrase as an idiom.",
    "- Briefly clarify grammar, contractions, informal spellings, or omitted words only when needed for understanding.",
    "- Do not separately explain ordinary pronouns or connecting words. If their role matters, mention it within the explanation of the phrase.",
    "- Keep fillers such as \u201cwell,\u201d \u201clike,\u201d and \u201cyou know\u201d with a neighboring phrase when natural, and briefly explain their conversational purpose when useful.",
    "- Use CONTEXT to resolve references, tone, and implied meaning, but do not explain CONTEXT separately.",
    "- If the meaning is uncertain, briefly state the uncertainty and give the most likely interpretation.",
    "- Do not invent missing context or silently correct possible caption errors. Mention a likely correction only when necessary.",
    "- Keep explanations concise. Do not add unrelated definitions or grammar lessons.",
  ].join("\n");

  // Earlier defaults, by hash. A section the viewer saved without touching
  // holds the default of the day it was saved, and would otherwise outlive
  // every later improvement to it. Those are read as "the default" instead;
  // anything actually edited hashes differently and is kept. (Since this list
  // began, an untouched section is saved empty, so it needs no entry here.)
  const RETIRED_DEFAULTS = new Set(["1tnidu9", "1l57i3f"]);

  function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  const rules = (value, fallback) => {
    const text = String(value || "").trim();
    return !text || RETIRED_DEFAULTS.has(hash(text)) ? fallback : text;
  };

  // Both speak the OpenAI chat-completions format — Gemini through Google's
  // OpenAI-compatible endpoint — so one request shape serves either; only the
  // URL, the key and the model differ. Each keeps its own key and model, so
  // switching back and forth does not wipe the other one.
  const PROVIDERS = {
    openai: {
      label: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      keyField: "apiKey",
      modelField: "model",
    },
    gemini: {
      label: "Gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      keyField: "geminiApiKey",
      modelField: "geminiModel",
    },
  };

  const DEFAULTS = {
    enabled: true, // switched in the toolbar popup; off, a pause explains nothing
    provider: "openai",
    apiKey: "", // OpenAI's; the name predates Gemini and is kept so stored keys still work
    model: "gpt-4.1-mini",
    geminiApiKey: "",
    geminiModel: "gemini-3.5-flash-lite",
    divideRules: DEFAULT_DIVIDE_RULES,
    groupingExamples: DEFAULT_GROUPING_EXAMPLES,
    explainRules: DEFAULT_EXPLAIN_RULES,
    targetLines: 3, // lines actually explained: the one playing, plus those before it
    contextSeconds: 10, // extra dialogue sent so the model reads those lines right
    fontFamily: "", // CSS font-family for the card; empty means YouTube's own font
    fontSize: 13, // px, the card's body text; every other size on the card scales with it
  };

  // Upper bounds are not taste. Every one of these lines is sent on every pause,
  // so a large number is a bigger bill and a slower card, and a very long window
  // buries the lines being asked about.
  const LIMITS = {
    targetLines: { min: 1, max: 12 },
    contextSeconds: { min: 0, max: 60 },
    fontSize: { min: 10, max: 28 },
  };

  // The family is written into a CSS custom property on YouTube's page. A value
  // the browser does not understand is simply ignored there, but nothing that
  // could close the declaration or the rule is let through in the first place.
  const cleanFont = (value) =>
    String(value || "")
      .replace(/[;{}<>\\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);

  function clamp(value, fallback, { min, max }) {
    // Checked before Number(), which turns null, "" and [] into 0 — a legal
    // value here, so a missing setting would silently become zero context
    // rather than the default.
    if (value === null || value === undefined || value === "") return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  // Storage is shared with the explanation cache and can be edited by hand, so
  // nothing read out of it is trusted. Callers get a usable value or the default
  // — never NaN, never an empty prompt section.
  function normalise(stored) {
    const s = { ...DEFAULTS, ...stored };
    return {
      provider: Object.hasOwn(PROVIDERS, s.provider) ? s.provider : DEFAULTS.provider,
      apiKey: String(s.apiKey || "").trim(),
      model: String(s.model || "").trim() || DEFAULTS.model,
      geminiApiKey: String(s.geminiApiKey || "").trim(),
      geminiModel: String(s.geminiModel || "").trim() || DEFAULTS.geminiModel,
      divideRules: rules(s.divideRules, DEFAULT_DIVIDE_RULES),
      groupingExamples: rules(s.groupingExamples, DEFAULT_GROUPING_EXAMPLES),
      explainRules: rules(s.explainRules, DEFAULT_EXPLAIN_RULES),
      targetLines: clamp(s.targetLines, DEFAULTS.targetLines, LIMITS.targetLines),
      contextSeconds: clamp(s.contextSeconds, DEFAULTS.contextSeconds, LIMITS.contextSeconds),
      fontFamily: cleanFont(s.fontFamily),
      fontSize: clamp(s.fontSize, DEFAULTS.fontSize, LIMITS.fontSize),
      // Only an explicit false turns it off: a missing or garbled value must not
      // silently switch the assistant off.
      enabled: s.enabled !== false,
    };
  }

  // The provider in use, with its endpoint, key and model, from normalised settings.
  function active(settings) {
    const p = PROVIDERS[settings.provider] || PROVIDERS[DEFAULTS.provider];
    return { label: p.label, url: p.url, apiKey: settings[p.keyField], model: settings[p.modelField] };
  }

  async function read() {
    return normalise(await chrome.storage.local.get(Object.keys(DEFAULTS)));
  }

  return {
    DEFAULTS,
    DEFAULT_DIVIDE_RULES,
    DEFAULT_GROUPING_EXAMPLES,
    DEFAULT_EXPLAIN_RULES,
    LIMITS,
    PROVIDERS,
    active,
    normalise,
    read,
  };
})();

globalThis.EnHintSettings = EnHintSettings;
