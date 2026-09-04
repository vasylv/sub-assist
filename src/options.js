const DEFAULTS = {
  apiKey: "",
  model: "gpt-4.1-mini",
  level: "B1",
};

const fields = Object.keys(DEFAULTS);
const el = (id) => document.getElementById(id);

async function load() {
  const stored = await chrome.storage.local.get(fields);
  const values = { ...DEFAULTS, ...stored };
  for (const key of fields) {
    const node = el(key);
    if (node.type === "checkbox") node.checked = Boolean(values[key]);
    else node.value = values[key];
  }
}

document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  await chrome.storage.local.set({
    apiKey: el("apiKey").value.trim(),
    model: el("model").value.trim() || DEFAULTS.model,
    level: el("level").value,
  });
  const saved = el("saved");
  saved.classList.add("show");
  setTimeout(() => saved.classList.remove("show"), 1200);
});

// Explanations are cached per video, cue, level and model, so they pile up. This
// is the escape hatch for "that explanation looks wrong, ask again".
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
