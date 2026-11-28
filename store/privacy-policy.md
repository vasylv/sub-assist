# Sub Assist — Privacy Policy

_Effective date: November 27, 2026_

Sub Assist is a Chrome extension that explains the English subtitles of a YouTube video when you pause it. This policy explains what data the extension handles, where it goes, and what it does not do.

## Summary

- The developer of Sub Assist does not collect, receive, or store any of your data. There is no Sub Assist server, account, analytics, or tracking.
- Your settings and API key are stored only in your own browser.
- When you pause a video, the subtitle lines you just heard are sent to the AI provider you chose (OpenAI or Google Gemini), using your own API key, to produce the explanation.

## Data stored on your device

The extension saves your settings in Chrome's extension storage (`chrome.storage.local`) on your computer:

- the AI provider you selected (OpenAI or Google Gemini) and the model name;
- your API key for that provider;
- your display and explanation preferences (number of lines, font, explanation rules, on/off switch, console logging).

This data never leaves your device except as described in the next section: your API key is sent only to the provider it belongs to. It is not synced to your Google account. It is deleted when you uninstall the extension.

Subtitles and explanations are kept only in memory while the YouTube tab is open and are discarded when you close or reload the tab. They are not saved.

## Data sent to third parties

The extension makes a network request only when you pause a YouTube video while the extension is switched on. The request goes directly from your browser to the provider you selected:

- **OpenAI** (`api.openai.com`), or
- **Google Gemini** (`generativelanguage.googleapis.com`).

It contains:

- the subtitle lines around the moment you paused (by default the last few lines and up to 10 seconds of surrounding dialogue);
- the instructions that tell the model how to explain them, including any edits you made in the settings;
- your API key, to authenticate the request with your provider account.

It does not include the video's address or ID, your YouTube account, your browsing history, or any other information about you or your device beyond what any web request carries (such as your IP address).

Your provider handles this data under its own terms and privacy policy, which you agreed to when you created your API key:

- OpenAI: https://openai.com/policies/privacy-policy
- Google: https://policies.google.com/privacy and https://ai.google.dev/gemini-api/terms

## How the extension reads YouTube

The extension runs only on `youtube.com`. It reads the subtitle track that the YouTube player downloads for the video you are watching, and it detects when you pause. It does not read your comments, account details, watch history, or any other page content, and it makes no requests to YouTube of its own. If subtitles are switched off, it may switch them on briefly, without showing them, so that the player downloads the track.

## What the extension does not do

- It does not sell or share your data with anyone other than the AI provider you selected.
- It does not use your data for advertising, profiling, creditworthiness, or any purpose other than explaining subtitles.
- It does not collect analytics, crash reports, or usage statistics.
- It does not run on any website other than YouTube.

The use of information received by Sub Assist adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Your control

- Switch the extension off at any time from its toolbar button. Nothing is sent while it is off.
- Remove your API key in the extension's settings at any time.
- Uninstall the extension to delete everything it stored.
- To have a provider delete data it received, contact OpenAI or Google directly, or use the controls in your provider account.

## Children

Sub Assist is not directed at children under 13 and does not knowingly collect any data from them.

## Changes to this policy

If this policy changes, the updated version will be published at this address with a new effective date. Material changes will also be noted in the extension's store listing.

## Contact

Questions about this policy: open an issue at https://github.com/vasylv/sub-assist/issues
