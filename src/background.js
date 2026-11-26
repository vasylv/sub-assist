// Service worker: the only place the OpenAI key lives.
//
// Keeping the key here rather than in a content script matters — a content
// script shares a page with YouTube's own JavaScript, and anything it holds is
// one bug away from being reachable. The service worker has no DOM and no page.
//
// One small request per pause. Nothing is sent while the video simply plays:
// the viewer pressing pause IS the request, so there is nothing to predict and
// nothing to pay for on a video they understood.

import "./settings.js"; // publishes globalThis.EnHintSettings
import { buildPrompt, cacheKeyFor, parseExplanation } from "./explain-core.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// The reply is plain text in the prompt's OUTPUT format, not forced JSON: that
// format covers every word of every target line, which a fixed short list of
// terms cannot. explain-core.js parses it for the card.
async function explain({ videoId, index, target, context, auto }) {
  const settings = await EnHintSettings.read();
  if (!settings.apiKey) {
    return { ok: false, error: "No OpenAI API key set. Open the extension options to add one." };
  }
  if (!Array.isArray(target) || !target.length) {
    return { ok: false, error: "nothing to explain here" };
  }

  const prompt = buildPrompt(settings, { target, context: context || [], auto });

  const cacheKey = cacheKeyFor(videoId, index, prompt, settings.model);
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  // An entry written by an older version holds a different shape; ask again.
  if (typeof cached === "string") return { ok: true, ...parseExplanation(cached), cached: true };

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned no content");

  // The raw reply is what is cached, so a better parser later re-reads old
  // answers instead of being stuck with how an earlier one split them.
  await chrome.storage.local.set({ [cacheKey]: content });
  return { ok: true, ...parseExplanation(content), cached: false };
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
