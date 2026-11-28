// Runs in the PAGE's JS world at document_start, before YouTube's own scripts.
//
// Two jobs:
//   1. Find out which caption tracks this video has.
//   2. Get the text of one, WITHOUT asking YouTube for it ourselves.
//
// (2) is the important one. The player has to download the caption track anyway
// in order to draw subtitles, and its request carries whatever short-lived
// tokens YouTube currently demands. So instead of building our own request
// against a signed URL, we listen for the player's and read the response.
// Nothing extra is requested, nothing signed is touched, and whatever token
// scheme YouTube moves to next is satisfied by the player, not by us.
//
// There is deliberately no fallback that fetches the signed baseUrl itself:
// that would be an automated request to YouTube outside the normal player, and
// avoiding it is the whole point of this file.

(() => {
  const CHANNEL = "sub-assist";
  const post = (type, payload) =>
    window.postMessage({ source: CHANNEL, type, payload }, window.location.origin);

  // ---- tracing -------------------------------------------------------------
  // Everything in this file happens between a navigation and a transcript, with
  // no UI in between, so the console is the only view of it. Every branch says
  // what it did — including the branches that deliberately do nothing, because
  // silence at a decision point is what makes a stall impossible to read.
  const T0 = Date.now();
  const since = () => `+${((Date.now() - T0) / 1000).toFixed(2)}s`;
  const TRACE_CSS =
    "background:#ffd166;color:#1a1a1a;font-weight:700;padding:1px 5px;border-radius:3px";

  // Off unless switched on in the options page. This world cannot read
  // extension storage, so src/content.js posts the setting over; until it
  // arrives lines are held, then printed if it is on and dropped if off.
  let logging = null; // null: not heard yet
  let held = [];

  function print(head, detail) {
    if (detail === undefined) console.log(head, TRACE_CSS, "");
    else console.log(head, TRACE_CSS, "", detail);
  }

  function trace(step, detail) {
    if (logging === false) return;
    const head = `%csub-assist page%c ${since()}  ${step}`;
    if (logging) print(head, detail);
    else if (held.length < 300) held.push([head, detail]);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== CHANNEL || msg.type !== "logging") return;
    const on = msg.payload?.on === true;
    if (logging === on) return;
    logging = on;
    if (on) for (const [head, detail] of held) print(head, detail);
    held = [];
  });

  // The video the isolated world currently holds a transcript for, and the ids
  // being set up right now. `lastVideoId` was one slot doing both jobs, which is
  // why a player response could only ever be acted on once.
  let sessionVideoId = null;
  const inFlight = new Set();

  const PLAYER_WAIT_MS = 15000; // how long to wait for #movie_player to exist
  const MODULE_GRACE_MS = 1500; // how long to let the captions module report itself
  const PROVOKE_ATTEMPTS = 3; // the first ask can land before the player is listening
  const PROVOKE_WAIT_MS = 4000; // per attempt
  const URL_SETTLE_MS = 1500; // how long pushState may lag a player response
  const PLAYER_RESPONSE_MS = 8000; // how long to let the player settle on a new video
  const KEEP = 12; // per cache — a long session passes a lot of videos

  // Caption tracks the player has downloaded, keyed by video id. Populated
  // continuously by the network hooks, so a track that arrives BEFORE we start
  // looking for it is kept rather than thrown away — the common case when the
  // viewer already has subtitles switched on.
  const capturedByVideo = new Map();

  // Player responses for a video the viewer had not reached yet. YouTube
  // prefetches these — the autoplay-next video, a hovered thumbnail — and then
  // serves the navigation out of its own cache without asking the server again.
  // Dropping one was dropping the only copy we would ever see.
  const parkedByVideo = new Map();

  // Transcripts already built, so coming back to a video is instant and does not
  // provoke the player into downloading the same track twice.
  const transcriptByVideo = new Map();

  /** @type {Array<{videoId: string, resolve: (cues: any[]) => void}>} */
  let waiters = [];

  // Bounded insert. A Map iterates in insertion order, so the oldest entry is
  // the first key out, and re-storing a key moves it back to the young end.
  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    for (const oldest of map.keys()) {
      if (map.size <= KEEP) break;
      map.delete(oldest);
    }
  }

  // ---- track selection -----------------------------------------------------
  function pickTrack(tracks) {
    const en = (t) => (t.languageCode || "").toLowerCase().startsWith("en");
    return (
      tracks.find((t) => en(t) && t.kind !== "asr") ||
      tracks.find((t) => en(t)) ||
      tracks.find((t) => t.kind !== "asr") ||
      tracks[0]
    );
  }

  // ---- parsers -------------------------------------------------------------
  const tidy = (s) => s.replace(/\s+/g, " ").trim();

  function decodeEntities(s) {
    if (!s.includes("&")) return s;
    const box = document.createElement("textarea");
    box.innerHTML = s;
    return box.value;
  }

  // Cues carry `segs`: the pieces of the line with the time each one is reached.
  // An auto-generated track times every word, and the player reveals them one at
  // a time, so a line that has *started* is not a line the viewer has *seen*.
  // Keeping the offsets is what lets a pause mid-line be cut back to the words
  // actually spoken by then. A track without word timings simply has one seg.
  function parseJson3(body) {
    const data = JSON.parse(body);
    return (data.events || [])
      .filter((e) => Array.isArray(e.segs))
      .map((e) => {
        const segs = e.segs
          .map((s) => ({ at: (e.tStartMs + (s.tOffsetMs || 0)) / 1000, text: s.utf8 || "" }))
          .filter((s) => s.text);
        return {
          start: e.tStartMs / 1000,
          end: (e.tStartMs + (e.dDurationMs || 0)) / 1000,
          text: tidy(segs.map((s) => s.text).join("")),
          segs,
        };
      })
      .filter((c) => c.text);
  }

  // The player may ask for either XML shape depending on version and track kind.
  function parseXml(body) {
    const doc = new DOMParser().parseFromString(body, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("timedtext XML did not parse");

    const legacy = [...doc.querySelectorAll("transcript > text")];
    if (legacy.length) {
      return legacy
        .map((node) => {
          const start = Number(node.getAttribute("start")) || 0;
          const dur = Number(node.getAttribute("dur")) || 0;
          // The legacy shape times whole lines and nothing finer, so the line is
          // its own single seg: it can only ever be sent whole.
          const text = tidy(decodeEntities(node.textContent || ""));
          return { start, end: start + dur, text, segs: [{ at: start, text }] };
        })
        .filter((c) => c.text);
    }

    return [...doc.querySelectorAll("body > p")]
      .map((node) => {
        const start = (Number(node.getAttribute("t")) || 0) / 1000;
        const dur = (Number(node.getAttribute("d")) || 0) / 1000;
        const segs = srv3Segs(node, start);
        return { start, end: start + dur, text: tidy(segs.map((s) => s.text).join("")), segs };
      })
      .filter((c) => c.text);
  }

  // srv3 puts word timings on <s t="..."> children, where `t` is an offset in
  // milliseconds from the <p>. Walking childNodes rather than querying for <s>
  // keeps any bare text between them, which would otherwise be dropped from the
  // line; such a piece inherits the time of the <s> before it.
  function srv3Segs(node, start) {
    const segs = [];
    let at = start;
    for (const child of node.childNodes) {
      if (child.nodeType === 1 && child.nodeName === "s") {
        const offset = child.getAttribute("t");
        if (offset !== null) at = start + (Number(offset) || 0) / 1000;
      }
      const text = child.textContent || "";
      if (text) segs.push({ at, text });
    }
    return segs;
  }

  function parseAny(body) {
    const trimmed = (body || "").trim();
    if (!trimmed) throw new Error("empty body");
    if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html"))
      throw new Error("got an HTML page, not a caption track");
    return trimmed.startsWith("{") ? parseJson3(trimmed) : parseXml(trimmed);
  }

  // ---- capture -------------------------------------------------------------
  // Caption requests carry the video id in the query string, so a response can
  // be filed against the right video without guessing from timing.
  function videoIdOf(url) {
    const match = /[?&]v=([^&]+)/.exec(url || "");
    return match ? decodeURIComponent(match[1]) : null;
  }

  // What the viewer is actually watching, as opposed to what YouTube happens to
  // be asking the server about.
  const watchedVideoId = () => videoIdOf(location.search);

  // Announced for every caption response either hook sees, before anything is
  // parsed. Silence here means the player never fetched a track — or that the
  // hooks are not on the path it used, which is a different problem entirely.
  function noteTimedText(url, how) {
    trace(`the player is downloading a caption track (${how})`, {
      videoId: videoIdOf(url),
    });
    post("timedtext-seen", { how, url: url.slice(0, 160) });
  }

  function captureTrack(url, body) {
    let cues;
    try {
      cues = parseAny(body);
    } catch (err) {
      // A response arrived and could not be read. Worth saying out loud: it is
      // the difference between "the player never fetched" and "it fetched
      // something in a shape we do not parse".
      post("attempt-failed", {
        label: "capture",
        message: `${String(err.message || err)} — ${(body || "").trim().slice(0, 80)}`,
      });
      return;
    }
    if (!cues.length) return;

    // A response with no `v=` belongs to whatever is on screen. It used to fall
    // back to the dedupe slot, which during a navigation names the video the
    // viewer has just left.
    const videoId = videoIdOf(url) || watchedVideoId();
    if (!videoId) return;

    // Keep the longest track seen for this video: the player sometimes fetches
    // a short partial first, and we would rather have the whole thing.
    const existing = capturedByVideo.get(videoId);
    if (existing && existing.length >= cues.length) {
      trace("caption track ignored — a longer one is already held", {
        videoId,
        held: existing.length,
        offered: cues.length,
      });
      return;
    }
    trace("caption track captured", { videoId, cues: cues.length });
    remember(capturedByVideo, videoId, cues);

    const pending = waiters.filter((w) => w.videoId === videoId);
    if (pending.length) {
      waiters = waiters.filter((w) => w.videoId !== videoId);
      pending.forEach((w) => w.resolve(cues));
    }
  }

  // Polls until `probe` returns something truthy, or the time runs out. Used
  // for anything that exists only once YouTube has built the page.
  function waitFor(probe, timeoutMs, everyMs = 200) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        let value = null;
        try {
          value = probe();
        } catch (_) {}
        if (value) return resolve(value);
        if (Date.now() >= deadline) return resolve(null);
        setTimeout(tick, everyMs);
      };
      tick();
    });
  }

  function waitForCapture(videoId, timeoutMs) {
    const already = capturedByVideo.get(videoId);
    if (already) return Promise.resolve(already);

    return new Promise((resolve) => {
      const waiter = { videoId, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        if (waiters.includes(waiter)) {
          waiters = waiters.filter((w) => w !== waiter);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  // ---- making the player fetch the track we want ---------------------------
  // The player only downloads a caption track when subtitles are actually on.
  // If they are off we switch them on, hide the rendered subtitles so the
  // viewer sees no flicker, and put everything back afterwards.
  const HIDE_ID = "sub-assist-hide-captions";

  function hideRenderedCaptions() {
    if (document.getElementById(HIDE_ID)) return;
    const style = document.createElement("style");
    style.id = HIDE_ID;
    style.textContent =
      ".ytp-caption-window-container, .caption-window { visibility: hidden !important; }";
    document.documentElement.appendChild(style);
  }

  function showRenderedCaptions() {
    const style = document.getElementById(HIDE_ID);
    if (style) style.remove();
  }

  function currentTrack(player) {
    try {
      const track = player.getOption && player.getOption("captions", "track");
      return track && track.languageCode ? track : null;
    } catch (_) {
      // Throws when the captions module has not loaded — which is the answer:
      // subtitles were off.
      return null;
    }
  }

  // The player element does not exist yet when a hard page load assigns
  // ytInitialPlayerResponse — that runs in an inline script at the top of the
  // document, long before YouTube builds the player. Asking it for anything at
  // that moment silently does nothing, which is exactly what a video that
  // reports "the player did not download a track" looks like.
  function playerApi() {
    const el = document.querySelector("#movie_player");
    return el && typeof el.loadModule === "function" && typeof el.setOption === "function"
      ? el
      : null;
  }

  function askForTrack(player, track) {
    try {
      player.loadModule("captions");
      player.setOption("captions", "track", {
        languageCode: track.languageCode,
        kind: track.kind || "",
      });
    } catch (_) {
      try {
        player.setOption("captions", "reload", true);
      } catch (_) {}
    }
  }

  async function provokeDownload(videoId, track) {
    const player = await waitFor(playerApi, PLAYER_WAIT_MS);
    if (!player) {
      trace("    #movie_player never became usable", { videoId });
      post("attempt-failed", {
        label: "player",
        message: `#movie_player never became usable within ${PLAYER_WAIT_MS} ms`,
      });
      return null;
    }

    // getOption throws until the captions module is loaded, and the module only
    // loads when subtitles are on — but not instantly. Without this grace period
    // a viewer who had subtitles on gets read as "off", and the restore below
    // then switches their subtitles off for them.
    const previous = await waitFor(() => currentTrack(player), MODULE_GRACE_MS);
    const wasOn = Boolean(previous);
    trace("    the viewer's subtitles were", wasOn ? `on (${previous.languageCode})` : "off");
    if (!wasOn) hideRenderedCaptions();

    let cues = null;
    try {
      for (let attempt = 1; attempt <= PROVOKE_ATTEMPTS && !cues; attempt++) {
        trace(`    asking the player for the track (try ${attempt}/${PROVOKE_ATTEMPTS})`, { videoId });
        askForTrack(player, track);
        cues = await waitForCapture(videoId, PROVOKE_WAIT_MS);
        if (!cues && attempt < PROVOKE_ATTEMPTS) {
          post("attempt-failed", {
            label: `player/try-${attempt}`,
            message: `no track after ${PROVOKE_WAIT_MS} ms — asking again`,
          });
        }
      }
    } finally {
      // This can take most of a minute, and the viewer may have navigated in the
      // meantime. `previous` is the caption setting of the video they LEFT, and
      // `player` is now showing a different one — restoring here would reach in
      // and change the captions of a video this call knows nothing about. The
      // session starting for that video owns its settings; leave them alone.
      if (watchedVideoId() !== videoId) {
        trace("    not restoring captions — the viewer navigated away mid-download", {
          videoId,
          watching: watchedVideoId(),
        });
      } else {
        try {
          if (wasOn) {
            player.setOption("captions", "track", previous);
          } else {
            player.unloadModule("captions");
          }
        } catch (_) {}
      }
      // The hiding style is ours and global, so it always comes off.
      showRenderedCaptions();
    }
    return cues;
  }

  // ---- entry point ---------------------------------------------------------
  async function handlePlayerResponse(pr, via) {
    const videoId = pr && pr.videoDetails && pr.videoDetails.videoId;
    if (!videoId) {
      trace("player response with no video id — ignored", { via });
      return;
    }
    trace("player response", { videoId, via, watching: watchedVideoId() });
    if (videoId === sessionVideoId) {
      trace("  skipped — already the running session", { videoId });
      return;
    }
    if (inFlight.has(videoId)) {
      trace("  skipped — a session for it is already starting", { videoId });
      return;
    }

    // YouTube fetches player responses for videos nobody is watching: sidebar
    // hover previews, the prefetch of what plays next, ads. Acting on one means
    // provoking #movie_player — which is playing something else — for a track it
    // will never download, and the failure that follows used to tear down the
    // session of the video actually on screen.
    //
    // The URL is the authority on what is playing. An in-app navigation can
    // update it a moment after the response arrives, so it gets that moment —
    // and when the moment passes the response is PARKED, not dropped. YouTube
    // serves the navigation to that video out of its own cache, so a discarded
    // response is very often the last one we would ever see for it, and the
    // video would then keep the previous video's transcript forever.
    const onScreen = await waitFor(() => watchedVideoId() === videoId, URL_SETTLE_MS);
    if (!onScreen) {
      remember(parkedByVideo, videoId, { pr, via });
      trace("  parked — the viewer is not on this video yet", {
        videoId,
        watching: watchedVideoId(),
        parked: parkedByVideo.size,
      });
      return;
    }

    inFlight.add(videoId);
    try {
      trace("  starting a session", { videoId });
      await startSession(videoId, pr, via);
    } finally {
      inFlight.delete(videoId);
    }
  }

  // Split out of handlePlayerResponse so onNavigation below can start a session
  // from a parked response without going back through the URL gate.
  async function startSession(videoId, pr, via) {
    const tracks =
      pr.captions &&
      pr.captions.playerCaptionsTracklistRenderer &&
      pr.captions.playerCaptionsTracklistRenderer.captionTracks;

    if (!tracks || !tracks.length) {
      sessionVideoId = videoId;
      trace("  this video has no caption tracks at all", { videoId });
      post("no-captions", { videoId, via });
      return;
    }

    sessionVideoId = videoId;
    const track = pickTrack(tracks);
    trace("  track chosen", {
      videoId,
      language: track.languageCode,
      auto: track.kind === "asr",
      available: tracks.map((t) => `${t.languageCode}${t.kind === "asr" ? "(auto)" : ""}`).join(", "),
    });
    post("track-found", {
      videoId,
      via,
      language: track.languageCode,
      auto: track.kind === "asr",
      available: tracks.map((t) => `${t.languageCode}${t.kind === "asr" ? "(auto)" : ""}`),
    });

    let cues = capturedByVideo.get(videoId) || null;
    let source = cues ? "player (already downloaded)" : null;

    if (cues) {
      trace("  the player had already downloaded this track", { videoId, cues: cues.length });
    } else {
      trace("  asking the player to download the track", { videoId });
      cues = await provokeDownload(videoId, track);
      if (cues) source = "player";
    }

    if (!cues) {
      post("attempt-failed", { label: "player", message: "the player did not download a track" });
      post("transcript-error", {
        videoId,
        via,
        message:
          "the player downloaded no caption track — try turning subtitles on for this video",
      });
      return;
    }

    const payload = {
      videoId,
      via: source,
      language: track.languageCode,
      auto: track.kind === "asr",
      cues,
    };
    remember(transcriptByVideo, videoId, payload);
    trace("  TRANSCRIPT SENT", { videoId, cues: cues.length, via: source });
    post("transcript", payload);
  }

  // ---- navigation ----------------------------------------------------------
  // Nothing here used to notice a navigation. A session could begin only when a
  // player response happened to arrive while the URL already named that video —
  // so a video whose response came early, and whose navigation YouTube then
  // served from its own cache, never got a session at all. The isolated world
  // was left holding the previous video's transcript, which is what "the script
  // does not switch" looks like from the outside.
  let seenVideoId = watchedVideoId();

  async function onNavigation(how) {
    const videoId = watchedVideoId();
    if (videoId === seenVideoId) return;
    const from = seenVideoId;
    seenVideoId = videoId;

    // Whatever session exists belongs to the video that just left the screen.
    sessionVideoId = null;
    trace("NAVIGATION", { from, to: videoId, noticed_by: how });
    if (!videoId) return;

    // Already built once — hand it straight back rather than provoking the
    // player into downloading the same track again.
    const known = transcriptByVideo.get(videoId);
    if (known) {
      sessionVideoId = videoId;
      trace("  already had a transcript for it — re-posting", {
        videoId,
        cues: known.cues.length,
      });
      post("transcript", known);
      return;
    }

    // The response arrived before the viewer did. This is the copy that used to
    // be thrown away.
    const parked = parkedByVideo.get(videoId);
    if (parked) {
      parkedByVideo.delete(videoId);
      trace("  replaying the parked player response", { videoId, via: parked.via });
      handlePlayerResponse(parked.pr, parked.via + " (parked)");
      return;
    }

    // Nothing arrived for this video, and nothing may ever arrive: YouTube
    // serves an in-app navigation out of its own cache, so there is frequently
    // no second request for the hooks to see. Waiting for one is what leaves the
    // card sitting on "reading subtitles…" forever.
    //
    // The player is holding the response it is playing from, so ask it directly.
    // This needs no network request and does not depend on catching YouTube's.
    trace("  nothing arrived for it — asking the player for its own response", { videoId });
    const pr = await waitFor(() => playerResponseFor(videoId), PLAYER_RESPONSE_MS);

    if (seenVideoId !== videoId) {
      trace("  gave up asking — the viewer moved on again", { videoId });
      return;
    }
    if (sessionVideoId === videoId || inFlight.has(videoId)) {
      trace("  a player response turned up while we asked", { videoId });
      return;
    }
    if (pr) {
      trace("  got it from player.getPlayerResponse()", { videoId });
      handlePlayerResponse(pr, "player.getPlayerResponse()");
      return;
    }

    trace("  NO caption information for this video from any route", { videoId });
    post("transcript-error", {
      videoId,
      via: "navigation",
      message: "no caption information arrived for this video — try reloading the page",
    });
  }

  // The response the player is currently playing from, if it is the one asked
  // for. `getPlayerResponse` is part of the same public player API this file
  // already uses for loadModule/setOption.
  function playerResponseFor(videoId) {
    const el = document.querySelector("#movie_player");
    if (!el || typeof el.getPlayerResponse !== "function") return null;
    let pr = null;
    try {
      pr = el.getPlayerResponse();
    } catch (_) {
      return null;
    }
    return pr && pr.videoDetails && pr.videoDetails.videoId === videoId ? pr : null;
  }

  // yt-navigate-finish is YouTube's own event and fires the moment the SPA
  // settles. It is not a public API, so it cannot be the only signal.
  window.addEventListener("yt-navigate-finish", () => onNavigation("yt-navigate-finish"));

  // The backstop. The isolated world shares this window and already runs a tick
  // of its own (src/scheduler.js), so it tells us the video changed rather than
  // this file starting a second timer to ask the same question.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== CHANNEL || msg.type !== "navigated") return;
    onNavigation("the isolated world");
  });

  trace("page-world script loaded", { watching: watchedVideoId() });

  // ---- route 1: window.ytInitialPlayerResponse -----------------------------
  let inlinePlayerResponse = window.ytInitialPlayerResponse;
  Object.defineProperty(window, "ytInitialPlayerResponse", {
    configurable: true,
    enumerable: true,
    get: () => inlinePlayerResponse,
    set: (value) => {
      inlinePlayerResponse = value;
      try {
        handlePlayerResponse(value, "ytInitialPlayerResponse");
      } catch (_) {}
    },
  });
  if (inlinePlayerResponse) handlePlayerResponse(inlinePlayerResponse, "ytInitialPlayerResponse");

  // ---- network hooks: always listening -------------------------------------
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = nativeFetch.apply(this, args);
    try {
      const input = args[0];
      const url = typeof input === "string" ? input : (input && input.url) || "";
      if (url.includes("/youtubei/v1/player")) {
        promise
          .then((res) => res.clone().json())
          .then((json) => handlePlayerResponse(json, "youtubei/player"))
          .catch(() => {});
      } else if (url.includes("/api/timedtext")) {
        noteTimedText(url, "fetch");
        promise
          .then((res) => res.clone().text())
          .then((body) => captureTrack(url, body))
          .catch(() => {});
      }
    } catch (_) {}
    return promise;
  };

  // The player does not always use fetch for caption tracks.
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      this.__enhUrl = String(url);
    } catch (_) {}
    return nativeOpen.call(this, method, url, ...rest);
  };

  // The response is only text when the player asked for text. Reading whatever
  // it actually asked for costs a few lines and removes a silent way to miss a
  // track that did arrive.
  function xhrBody(xhr) {
    switch (xhr.responseType) {
      case "":
      case "text":
        return xhr.responseText;
      case "json":
        return JSON.stringify(xhr.response);
      case "arraybuffer":
        return new TextDecoder().decode(new Uint8Array(xhr.response));
      default:
        return null; // blob and document are handled below / not used here
    }
  }

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (this.__enhUrl && this.__enhUrl.includes("/youtubei/v1/player")) {
        // The fetch hook used to be the only route for these. If the player asks
        // over XHR instead, missing it means never hearing about the video.
        this.addEventListener("load", () => {
          try {
            const body = xhrBody(this);
            if (body) handlePlayerResponse(JSON.parse(body), "xhr youtubei/player");
          } catch (err) {
            trace("could not read an XHR player response", String(err.message || err));
          }
        });
      }
      if (this.__enhUrl && this.__enhUrl.includes("/api/timedtext")) {
        noteTimedText(this.__enhUrl, "xhr");
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "blob" && this.response) {
              this.response.text().then((body) => captureTrack(this.__enhUrl, body));
              return;
            }
            const body = xhrBody(this);
            if (body) captureTrack(this.__enhUrl, body);
          } catch (_) {}
        });
      }
    } catch (_) {}
    return nativeSend.apply(this, args);
  };
})();
