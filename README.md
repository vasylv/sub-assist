# Sub Assist

A Chrome extension that explains the English you just heard. Pause a YouTube video and
the last three lines are explained on the spot — the idioms, the words worth knowing, the
references — in plain English.

Nothing is sent anywhere while you simply watch. Pressing pause **is** the request.

## How it works

1. **`src/main-world.js`** runs in the page's own JavaScript world at `document_start`
   and captures YouTube's *player response* by two routes, because YouTube delivers it
   two different ways:
   - a **hard page load** inlines it as `window.ytInitialPlayerResponse` — no network
     request happens, so it is caught with a property setter;
   - an **in-app click** fetches `POST /youtubei/v1/player` and never reassigns that
     variable — so `window.fetch` is wrapped as well.

   Only the response whose video id matches the `v=` in the address bar is acted on.
   YouTube fetches player responses for sidebar hover previews, the prefetch of what
   plays next, and ads; provoking the player for one of those always fails, and the
   failure would tear down the session of the video actually on screen.

   From it, `captions.playerCaptionsTracklistRenderer.captionTracks[]` says which
   subtitle tracks exist. The text itself is **not** requested from YouTube — the same
   file is read out of the player's own download instead. See below.

2. **`src/scheduler.js`** watches the `<video>` inside `#movie_player` and reports the
   moment you stop it. Pauses raised by scrubbing the progress bar or by an ad break are
   dropped — neither is a question about the language, and an ad's timeline has nothing
   to do with the cue times. The seek check is deferred by a turn, because the browser
   can raise `pause` a beat before it sets `seeking`.

3. **`src/content.js`** turns that pause into a request. It takes the line playing plus
   the two before it as the **target**, and whatever else started in the previous ten
   seconds as **context**, then draws the card.

4. **`src/background.js`** (the service worker) asks the chosen model provider — OpenAI or
   Google Gemini, through Gemini's OpenAI-compatible endpoint — to explain the target lines,
   with your CEFR level in the prompt and a strict JSON schema on the response. Every
   pause asks afresh; answers are not cached, since the same line is rarely paused on
   twice. The API
   key lives only here — never in a script that shares a page with YouTube.

## Behaviour

- **Any pause fires it, immediately.** No hold, no hotkey. The extension never pauses
  the video itself — playback is yours.
- **Ten seconds in, three lines explained.** The wider window is context only: it is
  sent so an idiom is read correctly, and any term the model lifts out of it is dropped
  before it reaches the card. The check is not a substring match — `term` comes back in
  dictionary form, so "go over someone's head" would never match "went over my head" —
  but at least one distinctive word of a real term does appear in the target lines.
- **The card never blocks the video.** It does not dim, does not cover the controls, and
  leaves on <kbd>Esc</kbd>, on its close button, or when you press play.
- **The lines appear instantly**; only the explanations wait on the network. Pressing
  play while a request is in flight discards the answer rather than showing it late.
- **Nothing to say is a real answer.** "Nothing unusual in these lines" beats padding.
- Pausing during an ad, in silence, or before the first line does nothing.

## Install

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
2. Open the extension's **options**, pick a provider (OpenAI or Gemini) and paste its API key
   — a Gemini key comes from Google AI Studio.
3. Open any YouTube video with subtitles.

The panel at the bottom-left of the player reports what happened; the console has the
detail (`[sub-assist]`).

## Verifying it

| Case | Exercises | Expect |
| --- | --- | --- |
| Pause on an idiom | the whole path | the lines instantly, explanations ~1s later |
| Pause, then immediately press play | the in-flight token | the card vanishes; no late answer |
| Scrub the progress bar | the seek guard | no card |
| Pause during an ad | the `ad-showing` guard | no card |
| Paste a `/watch` URL and press Enter | the `ytInitialPlayerResponse` setter | `N lines — looking for expressions…` |
| From there, click a sidebar video | the `fetch` wrapper | same, without a page reload |
| A video with human-written captions | track selection preferring non-ASR | console shows a track without `(auto-generated)` |
| A video with auto-captions only | the ASR fallback | `(auto-generated)` in the console line |
| A video with subtitles switched off in the player | the provoke-and-restore path | captions flick on invisibly, then back off |
| A video with no caption tracks at all | the no-captions path | `no subtitles on this video` |
| Hover the sidebar thumbnails while a video plays | the on-screen video guard | nothing in the console; the running video is untouched |
| Scrub the progress bar around | cue lookup under seeking | no stale or repeated stops |

### Reading the caption track

**The extension does not request captions from YouTube.** The player has to download the
caption track anyway in order to draw subtitles, and its request carries the short-lived
tokens YouTube now requires. So both `fetch` and `XMLHttpRequest` are wrapped, every
`/api/timedtext` response is parsed and filed against the video id in its query string,
and that copy is what gets used.

No extra request is made, nothing signed is touched, and whatever token scheme YouTube
moves to next is satisfied by the player rather than by us.

Two details make it reliable:

- **Responses are captured continuously, not only while something is waiting for one.**
  When the viewer already has subtitles on, the player downloads the track before we go
  looking for it, and that copy has to be kept rather than discarded.
- **If subtitles are off, they are switched on to provoke the download**, the rendered
  subtitles are hidden so there is no visible flicker, and the previous state is put back
  afterwards. This waits for `#movie_player` first: on a hard page load the player response
  is assigned by an inline script long before YouTube builds the player, so asking at that
  moment silently does nothing. It also waits a moment for the captions module to report
  itself before deciding subtitles were off, otherwise the restore switches off subtitles
  the viewer had on.

There is deliberately **no fallback that fetches the signed `baseUrl` itself**. That would
be an automated request to YouTube outside the normal player, which is the thing YouTube's
terms discourage, and avoiding it is the point of the design. If the player downloads no
track, the extension reports that and stops rather than going around it.

Each attempt logs why it gave out, so a video with no hints says which step failed.

## Cost

One small model request per pause — around ten seconds of dialogue, some 35 words —
and nothing at all for a video you never pause. Answers are not cached: pausing in
the same place again asks again, which is rare enough not to be worth storing.

This replaces an earlier design that sent the **whole transcript** up front and had the
model guess which expressions were above your level. It was dropped because a model
cannot know which words are unknown to *you*: it paid for every word of a 3,000-word
talk, explained things you already knew, and still missed the ones you did not. Your
finger on the pause key is a better signal than any amount of inference.

## Not built yet

- The **add-to-vocabulary** button on the card, and the list behind it.
- Live streams, which have no complete transcript to read up front.

## Security note

An API key inside an unpacked extension is readable by anyone with access to this
Chrome profile — there is no way around that. For personal use with a spending-limited
key that is fine. If this is ever shared with other people, the model call has to move
behind a backend you control.
