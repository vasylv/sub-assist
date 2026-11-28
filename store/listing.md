# Chrome Web Store listing — Sub Assist

Images: run `python3 scripts/store_assets.py` → `dist/store/`.
Package: run `./scripts/package.sh` → `dist/sub-assist-<version>.zip`.

| Store field | File | Required |
|---|---|---|
| Store icon (128×128) | `dist/store/store-icon-128.png` | yes |
| Screenshots (1280×800, ≤5) | `dist/store/screenshot-{1..4}-1280x800.png` | at least 1 |
| Small promo tile (440×280) | `dist/store/promo-small-440x280.png` | yes |
| Marquee promo tile (1400×560) | `dist/store/promo-marquee-1400x560.png` | optional |

## Name
Sub Assist

## Summary (max 132 chars)
Pause a YouTube video and get the subtitles you just heard explained in simple, natural English.

## Category
Education

## Description
Sub Assist helps you understand English videos on YouTube.

Pause the video, and Sub Assist explains the last lines you heard right on the screen. It splits each line into natural phrases and explains what each one means in that moment, in simple English. Idioms, slang, phrasal verbs, contractions and jokes are all covered.

• Pause to ask. Nothing happens while you watch. Pressing pause is the request.
• Explanations in context. The lines around the current one are used to work out references, tone and implied meaning.
• Whole phrases, not single words. "I was wondering if you could give me a hand" is explained as two ideas, not ten words.
• The video stays yours. The card never covers the player controls and closes when you press play or Esc.
• Bring your own key. Works with OpenAI or Google Gemini, using your own API key.
• Adjustable. Choose the model, how many lines to explain, the font, and the rules the explanations follow.

Requires a YouTube video with English subtitles (manual or auto-generated) and an OpenAI or Gemini API key.

## Single purpose
Explains the English subtitles of a paused YouTube video to language learners.

## Permission justifications
- **storage**: Saves the user's settings and API key. Nothing else is stored.
- **Host permission https://www.youtube.com/***: Reads the subtitle track of the video being watched and shows the explanation card over the player.
- **Host permission https://api.openai.com/***: Sends the paused subtitle lines to OpenAI when the user has chosen OpenAI, using the user's own key.
- **Host permission https://generativelanguage.googleapis.com/***: Same, for Google Gemini.
- **Remote code**: No. All code is in the package. Only subtitle text is sent to the API and only JSON text comes back.

## Data usage (Privacy practices tab)
- **Collected:** "Authentication information" (the user's own API key, kept in chrome.storage.local and sent only to the selected provider) and "Website content" (subtitle lines of the paused video, sent to the selected provider to produce the explanation).
- No data is sent to the developer. Nothing is sold, and nothing is used for anything other than the extension's single purpose.
- Tick all three certifications.
- A privacy policy URL is required because data goes to a third party (OpenAI or Google).
- Policy text: `store/privacy-policy.md` (host it publicly, paste the URL).
