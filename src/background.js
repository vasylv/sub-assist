// Service worker: the only place the API keys live.
//
// Keeping the keys here rather than in a content script matters — a content
// script shares a page with YouTube's own JavaScript, and anything it holds is
// one bug away from being reachable. The service worker has no DOM and no page.
//
// One small request per pause. Nothing is sent while the video simply plays:
// the viewer pressing pause IS the request, so there is nothing to predict and
// nothing to pay for on a video they understood.
//
// OpenAI and Gemini share one request: Gemini is called through Google's
// OpenAI-compatible endpoint, which takes the same body, the same Bearer
// header and answers in the same `choices[0].message.content` shape.

import "./settings.js"; // publishes globalThis.EnHintSettings
import { buildPrompt, cacheKeyFor, parseExplanation } from "./explain-core.js";

// The reply is plain text in the prompt's OUTPUT format, not forced JSON: that
// format covers every word of every target line, which a fixed short list of
// terms cannot. explain-core.js parses it for the card.
async function explain({ videoId, index, target, context, auto }) {
  const settings = await EnHintSettings.read();
  const provider = EnHintSettings.active(settings);
  if (!provider.apiKey) {
    return { ok: false, error: `No ${provider.label} API key set. Open the extension options to add one.` };
  }
  if (!Array.isArray(target) || !target.length) {
    return { ok: false, error: "nothing to explain here" };
  }

  const prompt = buildPrompt(settings, { target, context: context || [], auto });

  // Model IDs do not overlap between the providers, so the model alone keeps
  // their answers apart — and OpenAI answers cached before Gemini keep hitting.
  const cacheKey = cacheKeyFor(videoId, index, prompt, provider.model);
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  // An entry written by an older version holds a different shape; ask again.
  if (typeof cached === "string") return { ok: true, ...parseExplanation(cached), cached: true };

  console.debug(`[sub-assist] explain via ${provider.label} (${provider.model})`, { videoId, index });

  const res = await fetch(provider.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${provider.label} HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`${provider.label} returned no content`);

  // The raw reply is what is cached, so a better parser later re-reads old
  // answers instead of being stuck with how an earlier one split them.
  await chrome.storage.local.set({ [cacheKey]: content });
  return { ok: true, ...parseExplanation(content), cached: false };
}

// "off" on the toolbar icon while the assistant is disabled, so it is visible
// from any tab, not only from inside a YouTube player.
async function updateBadge() {
  const { enabled } = await EnHintSettings.read();
  await chrome.action.setBadgeBackgroundColor({ color: "#6b6b70" });
  await chrome.action.setBadgeText({ text: enabled ? "" : "off" });
}
updateBadge();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "enabled" in changes) updateBadge();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "explain") {
    explain(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the channel open for the async reply
  }
  return false;
});
