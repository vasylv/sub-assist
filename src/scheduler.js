// Watches playback and reports the moment the viewer stops it.
//
// Loaded ahead of src/content.js in the same ISOLATED-world manifest entry, so
// the `EnHintPlayback` binding below is visible to content.js.
//
// This used to drive the video: it held a list of marks, ran a requestAnimation-
// Frame clock, and paused playback itself at chosen cues. None of that is left.
// The viewer controls playback now, and the only question this file answers is
// "did they just stop, and where?".

const EnHintPlayback = (() => {
  const REATTACH_MS = 2000; // the player can swap the <video> on navigation

  const currentVideoId = () => new URLSearchParams(location.search).get("v");

  /**
   * @param {object} opts
   * @param {(seconds:number) => void} opts.onPause      the viewer stopped, at this time
   * @param {() => void} [opts.onResume]                 playback started again
   * @param {(videoId:string|null) => void} [opts.onNavigate]  a different video is on screen
   */
  function create({ onPause, onResume, onNavigate }) {
    let player = null;
    let video = null;
    let timer = 0;
    let seenVideoId = currentVideoId();

    // --- what counts as a pause ----------------------------------------------
    // Scrubbing the progress bar raises `pause` too, and so does an ad break.
    // Neither is a question about the language, and an ad's timeline has nothing
    // to do with the cue times, so both are dropped.
    //
    // The check is deferred by a turn rather than run inline: on a scrub the
    // browser can raise `pause` a beat before it sets `seeking`, and reading the
    // flag too early would let the scrub through.
    function handlePause() {
      setTimeout(() => {
        if (!video || !video.paused || video.seeking || video.ended) return;
        if (player && player.classList.contains("ad-showing")) return;
        if (video.currentTime <= 0) return;
        onPause(video.currentTime);
      }, 0);
    }

    function handlePlay() {
      if (onResume) onResume();
    }

    // --- attachment ----------------------------------------------------------
    // Scoped to #movie_player so we never pick up a preview or the miniplayer.
    function attach() {
      player = document.querySelector("#movie_player");
      const next = player && player.querySelector("video");
      if (!next) return false;
      if (next === video) return true;

      if (video) removeListeners(video);
      video = next;
      video.addEventListener("pause", handlePause);
      video.addEventListener("play", handlePlay);
      return true;
    }

    function removeListeners(el) {
      el.removeEventListener("pause", handlePause);
      el.removeEventListener("play", handlePlay);
    }

    // --- which video is on screen --------------------------------------------
    // The same re-attach tick answers this: an in-app navigation replaces the
    // <video> element and changes the URL, and both are worth noticing on the
    // same beat. Folding the check in here keeps the extension to one timer.
    function checkVideo() {
      const next = currentVideoId();
      if (next === seenVideoId) return;
      seenVideoId = next;
      if (onNavigate) onNavigate(next);
    }

    function tick() {
      attach();
      checkVideo();
    }

    return {
      start() {
        if (timer) return;
        attach();
        // An in-app navigation can replace the element without any event we can
        // hear from here, so attachment is re-checked rather than assumed.
        timer = setInterval(tick, REATTACH_MS);
      },
      stop() {
        clearInterval(timer);
        timer = 0;
        if (video) removeListeners(video);
        video = null;
        player = null;
      },
      /** Re-attach immediately, without waiting for the next check. */
      reattach: attach,
      /** Check for a navigation now, rather than on the next tick. */
      checkVideo,
      isPaused: () => Boolean(video && video.paused),
      currentTime: () => (video ? video.currentTime : 0),
      seekTo(seconds) {
        if (video) video.currentTime = Math.max(0, seconds);
      },
    };
  }

  return { create };
})();
