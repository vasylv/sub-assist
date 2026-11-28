// Isolated-world half: owns the cue list and the UI.
//
// Receives the transcript from src/main-world.js and keeps it here. Nothing is
// sent anywhere until the viewer pauses; then the lines they just heard go to
// the service worker to be explained, and the answer is drawn on the player.
//
// Uses EnHintPlayback (src/scheduler.js, loaded ahead of this file in the same
// manifest entry) to hear about pauses.

const CHANNEL = "sub-assist";

// ---- tracing ---------------------------------------------------------------
// Both halves of the extension write to this console, so each line says which
// world it came from. src/main-world.js logs "sub-assist page"; this is the half
// that owns the cues and the card.
const T0 = Date.now();
const since = () => `+${((Date.now() - T0) / 1000).toFixed(2)}s`;
const TRACE_CSS =
  "background:#6fcb98;color:#10241a;font-weight:700;padding:1px 5px;border-radius:3px";

// Off unless switched on in the options page. Storage answers a tick after
// this file starts, and the first steps happen before that, so until the
// setting is known lines are held rather than lost: printed if it turns out to
// be on, dropped if off.
let logging = null; // null: not read yet
let held = [];

function print(head, detail) {
  if (detail === undefined) console.log(head, TRACE_CSS, "");
  else console.log(head, TRACE_CSS, "", detail);
}

function trace(step, detail) {
  if (logging === false) return;
  const head = `%csub-assist ui%c ${since()}  ${step}`;
  if (logging) print(head, detail);
  else if (held.length < 300) held.push([head, detail]);
}

// Also tells the page world (src/main-world.js), which cannot read storage.
function setLogging(on) {
  window.postMessage({ source: CHANNEL, type: "logging", payload: { on } }, location.origin);
  if (logging === on) return;
  logging = on;
  if (on) for (const [head, detail] of held) print(head, detail);
  held = [];
}

const SILENCE_S = 10; // paused this long after the last line means nothing to explain

// How much of the dialogue a pause sends. Both are the viewer's, set in the
// options page (src/settings.js holds the defaults and the bounds).
//
// Storage is asynchronous, so these start at the defaults and are corrected a
// tick later. A pause inside that tick still works; it just uses the defaults.
let targetLines = EnHintSettings.DEFAULTS.targetLines;
let contextSeconds = EnHintSettings.DEFAULTS.contextSeconds;

// How the card is drawn. Kept here as well as on the card, because the card is
// rebuilt whenever YouTube replaces the player, and the new one needs them too.
let fontFamily = EnHintSettings.DEFAULTS.fontFamily;
let fontSize = EnHintSettings.DEFAULTS.fontSize;

// Switched from the toolbar popup. Off means a pause explains nothing and costs nothing. The transcript is still
// read, so switching back on works on the spot, mid-video.
let enabled = EnHintSettings.DEFAULTS.enabled;

const UI_KEYS = ["enabled", "targetLines", "contextSeconds", "fontFamily", "fontSize", "logging"];

function applySettings(s) {
  setLogging(s.logging);
  const current = { enabled, targetLines, contextSeconds, fontFamily, fontSize };
  if (UI_KEYS.every((k) => s[k] === current[k])) return;
  const switched = s.enabled !== enabled;
  enabled = s.enabled;
  targetLines = s.targetLines;
  contextSeconds = s.contextSeconds;
  fontFamily = s.fontFamily;
  fontSize = s.fontSize;
  if (root) applyFont(root);
  trace("settings changed", { enabled, targetLines, contextSeconds, fontFamily: fontFamily || "(YouTube)", fontSize });
  if (switched) applyEnabled();
}

// Off: drop any card and any reply still in flight, and hide the status pill
// (nothing it says applies while switched off). A root built later picks the
// state up in ensureRoot.
function applyEnabled() {
  if (!enabled) dismiss();
  if (root) root.toggleAttribute("data-disabled", !enabled);
}

// An empty family removes the property, which falls back to YouTube's font in
// overlay.css. A family the browser cannot parse is dropped by setProperty, with
// the same result.
function applyFont(el) {
  if (fontFamily) el.style.setProperty("--enh-font", fontFamily);
  else el.style.removeProperty("--enh-font");
  el.style.setProperty("--enh-font-size", `${fontSize}px`);
}

EnHintSettings.read().then(applySettings);

// Saving the options page must not need a reload of every open YouTube tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!UI_KEYS.some((k) => k in changes)) return;
  EnHintSettings.read().then(applySettings);
});

// The video the viewer is on. Anything reported for a different one is about a
// hover preview or a prefetch, and must never touch the running session.
const watchedVideoId = () => new URLSearchParams(location.search).get("v");

/** @type {Array<{start:number,end:number,text:string,segs:Array<{at:number,text:string}>}>} */
let cues = [];
let videoId = null;
let isAuto = false;
let requestToken = 0; // invalidates the reply to a pause the viewer moved past

const playback = EnHintPlayback.create({
  onPause: explainAt,
  onResume: dismiss,
  onNavigate: onNavigation,
});
playback.start();

// YouTube's own navigation event, for the instant path. The scheduler's tick
// above is the backstop for the day it is renamed; nothing here depends on this
// event firing.
window.addEventListener("yt-navigate-finish", () => playback.checkVideo());

trace("ui script loaded", { watching: watchedVideoId() });

// --- transcript in ----------------------------------------------------------

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== CHANNEL) return;

  switch (msg.type) {
    case "transcript":
      // The same guard the two handlers below already have: a transcript that
      // finished building after the viewer moved on belongs to nothing.
      if (msg.payload.videoId !== watchedVideoId()) {
        trace("transcript IGNORED — it is for another video", {
          arrived_for: msg.payload.videoId,
          watching: watchedVideoId(),
        });
        break;
      }
      onTranscript(msg.payload);
      break;
    case "no-captions":
      if (msg.payload.videoId !== watchedVideoId()) break;
      trace("this video has no subtitles at all", { videoId: msg.payload.videoId });
      resetVideo(msg.payload.videoId);
      setStatus("no subtitles on this video", "warn");
      break;
    // Diagnostics: which way of reading the track failed, and why. These are
    // the lines to read first when a video comes back with no subtitles.
    case "attempt-failed":
      trace(`transcript attempt "${msg.payload.label}" failed`, msg.payload.message);
      break;
    // "timedtext-seen" and "track-found" are still posted, but the page world
    // now traces both with more detail than this relay ever had. Repeating them
    // here only made the log harder to read.
    case "transcript-error":
      if (msg.payload.videoId !== watchedVideoId()) break;
      trace("COULD NOT READ SUBTITLES", {
        videoId: msg.payload.videoId,
        why: msg.payload.message,
      });
      resetVideo(msg.payload.videoId);
      setStatus("could not read subtitles", "warn");
      break;
  }
});

function onTranscript(payload) {
  resetVideo(payload.videoId);
  cues = payload.cues;
  isAuto = Boolean(payload.auto);
  playback.reattach();

  trace("TRANSCRIPT IN — ready to explain", {
    videoId: payload.videoId,
    cues: cues.length,
    auto: isAuto,
    via: payload.via,
  });
  setStatus(`${cues.length} lines ready — pause to explain`, "ok");
}

function resetVideo(nextId) {
  videoId = nextId;
  cues = [];
  isAuto = false;
  requestToken++;
  hideCard();
}

// --- following the viewer between videos ------------------------------------
// A transcript belongs to one video. Nothing here used to notice a navigation:
// resetVideo ran only from a message handler, so when src/main-world.js had
// nothing to say about the new video — its player response having arrived
// before the URL changed, and the navigation then served from YouTube's own
// cache — the previous video's cues simply stayed, and a pause on the new video
// was answered with lines from the old one.
//
// This resets on the navigation itself. Whatever the page world does or fails
// to do, the wrong lines can no longer be shown.

function onNavigation(nextId) {
  trace("NAVIGATION — dropping the old transcript", { from: videoId, to: nextId });
  resetVideo(nextId);
  playback.reattach(); // the player swaps the <video> element on navigation
  if (nextId) setStatus("reading subtitles…", "ok");

  // The page world shares this window but has no tick of its own. Telling it
  // here saves it starting a second timer to ask the same question.
  window.postMessage({ source: CHANNEL, type: "navigated", payload: { videoId: nextId } }, location.origin);
}

// --- the lines behind a pause -----------------------------------------------
// TARGET is the line playing plus the two before it, each cut off at the moment
// the viewer paused. CONTEXT is whatever else started inside the ten seconds
// before the pause: it is sent so an idiom is read correctly, and the service
// worker drops anything explained out of it.

const tidy = (s) => s.replace(/\s+/g, " ").trim();

// A line that has started is not a line the viewer has heard. On an auto-
// generated track the player reveals a cue word by word, so pausing a moment
// into a long line leaves most of it still ahead of the playhead — and sending
// it whole is what lets the model explain something not on screen yet.
//
// src/main-world.js keeps the time of each piece of the line, so the tail can be
// cut off exactly. A track timed only per line has one piece and survives whole.
function spokenText(cue, time) {
  const segs = cue.segs;
  if (!segs || !segs.length) return cue.text;
  if (segs[segs.length - 1].at <= time) return cue.text;
  return tidy(
    segs
      .filter((s) => s.at <= time)
      .map((s) => s.text)
      .join("")
  );
}

function linesAt(time) {
  let last = -1;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].start <= time) last = i;
    else break;
  }
  if (last < 0) return null;
  // Paused in a long silence — a title card, a musical break — with the last
  // spoken line well behind. There is nothing they just heard.
  if (time - cues[last].end > SILENCE_S) return null;

  const from = Math.max(0, last - (targetLines - 1));

  // Measured back from the first explained line, not from the pause. The two
  // settings are knobs the viewer turns separately, so asking for more lines
  // must not silently eat the context window they asked for.
  const windowStart = cues[from].start - contextSeconds;
  let ctxFrom = from;
  while (ctxFrom > 0 && cues[ctxFrom - 1].end > windowStart) ctxFrom--;

  // Every cue is cut at the pause, not only the one still playing: cues on an
  // auto-generated track overlap, so the line before the current one can have
  // words ahead of the playhead too. A cue left with nothing is dropped.
  const heard = (start, stop) => {
    const out = [];
    for (let i = start; i < stop; i++) {
      const text = spokenText(cues[i], time);
      if (text) out.push({ index: i, text });
    }
    return out;
  };

  const target = heard(from, last + 1);
  if (!target.length) return null;

  return {
    index: last,
    target,
    context: heard(ctxFrom, from),
    start: cues[target[0].index].start,
    end: Math.min(cues[target[target.length - 1].index].end, time),
  };
}

async function explainAt(time) {
  if (!enabled) {
    trace("paused, but the assistant is switched off", { at: time.toFixed(1) + "s" });
    return;
  }
  if (!cues.length) {
    trace("paused, but there is no transcript yet", { at: time.toFixed(1) + "s", videoId });
    return;
  }
  // These cues belong to the video named in the URL, or they belong to nothing.
  // Without this, a stale transcript is explained AND cached under the wrong id.
  if (videoId !== watchedVideoId()) {
    trace("paused, but the transcript is for another video", {
      transcript_for: videoId,
      watching: watchedVideoId(),
    });
    return;
  }
  const lines = linesAt(time);
  if (!lines) {
    trace("paused in silence — nothing was being said", { at: time.toFixed(1) + "s" });
    return;
  }
  trace("PAUSED — explaining", {
    videoId,
    at: time.toFixed(1) + "s",
    cue: lines.index,
    target: lines.target.map((c) => c.text).join(" "),
  });

  const token = ++requestToken;
  showCard(lines);

  let result;
  try {
    result = await chrome.runtime.sendMessage({
      type: "explain",
      videoId,
      index: lines.index,
      target: lines.target,
      context: lines.context,
      auto: isAuto,
    });
  } catch (err) {
    if (token === requestToken) showError("could not reach the extension");
    console.error("[sub-assist] explain message failed:", err);
    return;
  }

  // They pressed play, or paused somewhere else, while this was in flight.
  if (token !== requestToken) return;

  if (!result || !result.ok) {
    showError(result?.error || "explanation failed");
    return;
  }
  trace(result.cached ? "  explained (from cache)" : "  explained", {
    parts: result.parts ? result.parts.map((p) => p.part) : [],
    unparsed: result.raw !== undefined ? result.raw : null,
  });
  showExplanation(result);
}

// --- the card ---------------------------------------------------------------
// Mounted inside #movie_player, not on document.body: the fullscreen element is
// the player container, so anything outside it vanishes in fullscreen.
//
// It does not dim the video and does not block it. The viewer paused on
// purpose; nothing should be taken away from them for asking a question.

let root = null;

function ensureRoot() {
  const player = document.querySelector("#movie_player");
  if (!player) return null;
  if (root && root.parentElement === player) return root;

  root = document.createElement("div");
  root.className = "enh-root";
  root.innerHTML = `
    <div class="enh-card" role="dialog" aria-live="polite" hidden>
      <div class="enh-card-head">
        <span class="enh-kind"></span>
        <span class="enh-time"></span>
        <button class="enh-close" type="button" aria-label="Close">&times;</button>
      </div>
      <p class="enh-lines"></p>
      <div class="enh-items"></div>
    </div>
    <div class="enh-panel" hidden>
      <span class="enh-status"></span>
    </div>`;
  applyFont(root);
  root.toggleAttribute("data-disabled", !enabled);
  player.appendChild(root);
  root.querySelector(".enh-close").addEventListener("click", dismiss);
  return root;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && root && !root.querySelector(".enh-card").hidden) dismiss();
});

function formatTime(seconds) {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function showCard(lines) {
  const el = ensureRoot();
  if (!el) return;

  // Near the start of a video there are fewer lines than asked for, so the
  // header counts what was actually sent rather than the setting.
  const n = lines.target.length;
  el.querySelector(".enh-kind").textContent = n === 1 ? "last line" : `last ${n} lines`;
  el.querySelector(".enh-time").textContent =
    `${formatTime(lines.start)} – ${formatTime(lines.end)}`;

  // The lines are already here, so they paint on the same frame as the pause.
  // Only the explanations wait on the network.
  const box = el.querySelector(".enh-lines");
  box.textContent = "";
  for (const cue of lines.context) {
    const span = document.createElement("span");
    span.className = "enh-ctx";
    span.textContent = cue.text + " ";
    box.appendChild(span);
  }
  box.appendChild(document.createTextNode(lines.target.map((c) => c.text).join(" ")));

  const items = el.querySelector(".enh-items");
  items.textContent = "";
  items.className = "enh-items enh-loading";
  for (let i = 0; i < 2; i++) {
    const row = document.createElement("div");
    row.className = "enh-item";
    row.innerHTML = `<span class="enh-skel" style="width:${52 - i * 8}%"></span>
                     <span class="enh-skel" style="width:${88 - i * 12}%"></span>`;
    items.appendChild(row);
  }
  el.querySelector(".enh-card").hidden = false;
}

// One row per part, in the order the words were spoken: the exact words, then
// what they mean here.
function showExplanation(result) {
  const el = ensureRoot();
  if (!el) return;
  const items = el.querySelector(".enh-items");
  items.className = "enh-items";
  items.textContent = "";

  // The reply did not follow the format: show it as it came rather than lose it.
  if (!result.parts) {
    const p = document.createElement("p");
    p.className = "enh-raw";
    p.textContent = result.raw || "No explanation came back.";
    items.appendChild(p);
    return;
  }

  for (const note of result.notes) {
    const p = document.createElement("p");
    p.className = "enh-note";
    p.textContent = note;
    items.appendChild(p);
  }

  for (const part of result.parts) {
    const row = document.createElement("div");
    row.className = "enh-item";
    const term = document.createElement("span");
    term.className = "enh-term";
    term.textContent = part.part;
    if (part.where) {
      const where = document.createElement("small");
      where.textContent = part.where;
      term.appendChild(where);
    }
    const meaning = document.createElement("span");
    meaning.className = "enh-meaning";
    meaning.textContent = part.explanation;
    row.append(term, meaning);
    items.appendChild(row);
  }
}

function showError(message) {
  const el = ensureRoot();
  if (!el) return;
  const items = el.querySelector(".enh-items");
  items.className = "enh-items";
  items.textContent = "";
  const p = document.createElement("p");
  p.className = "enh-error";
  p.textContent = message;
  items.appendChild(p);
}

function hideCard() {
  if (!root) return;
  root.querySelector(".enh-card").hidden = true;
}

// Pressing play, pressing Esc, or closing the card all mean the same thing: the
// question is answered. Bumping the token also drops any reply still in flight.
function dismiss() {
  requestToken++;
  hideCard();
}

function setStatus(text, tone) {
  const el = ensureRoot();
  if (!el) {
    // The player is not in the DOM yet; try again once it is.
    setTimeout(() => setStatus(text, tone), 400);
    return;
  }
  const panel = el.querySelector(".enh-panel");
  panel.hidden = false;
  panel.dataset.tone = tone;
  el.querySelector(".enh-status").textContent = text;
}
