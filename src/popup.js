// The toolbar popup: switch the assistant on and off.
//
// It only writes `enabled` to storage. Every YouTube tab listens for that
// change and follows it at once — closing an open card when switched off —
// and the service worker puts "off" on the toolbar icon.

const el = (id) => document.getElementById(id);
let enabled = true;

function render(settings) {
  enabled = settings.enabled;
  el("state").dataset.on = String(enabled);
  el("stateText").textContent = enabled
    ? "On — pause a video to explain what you heard."
    : "Off — pausing a video does nothing.";

  const toggle = el("toggle");
  toggle.textContent = enabled ? "Disable assistant" : "Enable assistant";
  toggle.className = enabled ? "" : "primary";
  toggle.disabled = false;

  const provider = EnHintSettings.active(settings);
  el("noKey").hidden = Boolean(provider.apiKey);
  el("noKeyProvider").textContent = provider.label;
}

el("toggle").addEventListener("click", async () => {
  el("toggle").disabled = true;
  await chrome.storage.local.set({ enabled: !enabled });
  render(await EnHintSettings.read());
});

el("settings").addEventListener("click", (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
  window.close();
});

// Another window's popup can change this while this one is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "enabled" in changes) EnHintSettings.read().then(render);
});

EnHintSettings.read().then(render);
