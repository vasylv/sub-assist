// The options page. Defaults, bounds and validation all live in
// src/settings.js, loaded ahead of this file — this only moves values between
// storage and the form.

const FIELDS = ["provider", "apiKey", "model", "geminiApiKey", "geminiModel", "divideRules", "groupingExamples", "explainRules", "targetLines", "contextSeconds", "fontFamily", "fontSize", "logging"];
const el = (id) => document.getElementById(id);
// Checkboxes hold their value in `checked`, everything else in `value`.
const getField = (key) => (el(key).type === "checkbox" ? el(key).checked : el(key).value);
const setField = (key, v) => (el(key).type === "checkbox" ? (el(key).checked = v) : (el(key).value = v));

async function load() {
  const values = await EnHintSettings.read();
  for (const key of FIELDS) setField(key, values[key]);
  showProvider();
  preview();
}

// Only the chosen provider's key and model are shown; the other's stay stored.
function showProvider() {
  const chosen = el("provider").value;
  for (const box of document.querySelectorAll("[data-provider]")) box.hidden = box.dataset.provider !== chosen;
}
el("provider").addEventListener("change", showProvider);

// Shows the font as it is typed, before Save. Goes through normalise() so the
// preview is what will actually be stored and drawn, clamping included.
function preview() {
  const { fontFamily, fontSize } = EnHintSettings.normalise({
    fontFamily: el("fontFamily").value,
    fontSize: el("fontSize").value,
  });
  const box = el("fontPreview");
  box.style.fontFamily = fontFamily; // empty falls back to the stylesheet's YouTube font
  box.style.fontSize = `${fontSize}px`;
}
el("fontFamily").addEventListener("input", preview);
el("fontSize").addEventListener("input", preview);

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();

  // Normalise before storing, not after reading: a number typed out of range,
  // or a prompt emptied by accident, is corrected once here rather than by
  // every reader forever.
  const values = EnHintSettings.normalise(Object.fromEntries(FIELDS.map((k) => [k, getField(k)])));
  // A prompt section left at its default is stored empty, so the next version's
  // better default reaches this viewer too instead of being pinned at today's.
  const sectionDefaults = {
    divideRules: EnHintSettings.DEFAULT_DIVIDE_RULES,
    groupingExamples: EnHintSettings.DEFAULT_GROUPING_EXAMPLES,
    explainRules: EnHintSettings.DEFAULT_EXPLAIN_RULES,
  };
  for (const [key, fallback] of Object.entries(sectionDefaults)) {
    if (values[key] === fallback) values[key] = "";
  }
  // Only the form's own fields. normalise() fills in every setting, and writing
  // its default `enabled` back would switch the assistant on behind the popup.
  await chrome.storage.local.set(Object.fromEntries(FIELDS.map((k) => [k, values[k]])));
  // The single free-form prompt this replaced; nothing reads it any more.
  await chrome.storage.local.remove("prompt");

  // Show what was actually stored, so a clamped number does not silently
  // disagree with the box it was typed into.
  await load();

  const saved = el("saved");
  saved.classList.add("show");
  setTimeout(() => saved.classList.remove("show"), 1200);
});

// Puts a section's default back in its box without saving it — the viewer
// still has to press Save, so this is undoable by navigating away.
for (const button of document.querySelectorAll("button.reset")) {
  button.addEventListener("click", () => {
    const box = el(button.dataset.field);
    box.value = EnHintSettings[button.dataset.default];
    box.focus();
  });
}

// Explanations are cached per video, cue, prompt and model, so they pile up.
// This is the escape hatch for "that explanation looks wrong, ask again" —
// and editing the prompt already asks again on its own, because the prompt is
// part of the key.
//
// `scan:` and `transcript:` are swept too: they are left over from the version
// that analysed the whole transcript up front, and nothing reads them now.
document.getElementById("clear").addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const stale = ["explain:", "scan:", "transcript:"];
  const keys = Object.keys(all).filter((k) => stale.some((p) => k.startsWith(p)));
  await chrome.storage.local.remove(keys);
  const saved = el("saved");
  saved.textContent = `Cleared ${keys.length}`;
  saved.classList.add("show");
  setTimeout(() => {
    saved.classList.remove("show");
    saved.textContent = "Saved";
  }, 1600);
});

load();
