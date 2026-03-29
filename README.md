# LinkedIn AI Post Detector

A Chrome extension that detects AI-generated posts in your LinkedIn feed using client-side pattern matching. No data leaves your browser.

## How it works

The extension scans post text for four AI "anchors" — patterns that are strong indicators of AI-generated content:

1. **Em-dash (—)** — Real people almost never type em-dashes. LLMs use them constantly.
2. **Non-human emoji** — Faces, hands, and hearts are natural. Everything else (🔥, ✅, 💡, 🚀, ➡️, 📈) requires digging through emoji menus that real people skip.
3. **Single-sentence paragraphs** — The AI cadence of one punchy line per paragraph, 6+ lines in a row. Humans mix in multi-sentence paragraphs naturally.
4. **Hook + bullet list + CTA** — Short opening line, then a bulleted/numbered list, ending with "Agree? Thoughts? Follow me!" The LinkedIn AI playbook.

When a post triggers one anchor, it gets a **yellow** shading. Two or more anchors trigger **red** shading. Images and videos in flagged posts are collapsed so you can scroll past faster.

Posts with zero anchors are left completely untouched.

## Installation

1. Clone this repo or download the ZIP
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `linkedin-ai-detector` folder (the one containing `manifest.json`)
6. Navigate to LinkedIn — the extension runs automatically

## Usage

- Scroll your LinkedIn feed normally. Flagged posts will be shaded yellow or red.
- Hover over the small dot at the top of a flagged post to see which anchors triggered.
- Click the extension icon in your toolbar to toggle it on/off or view stats.

## Philosophy

Rather than using dozens of fuzzy heuristics with a scoring system, this extension uses a small number of high-confidence signals. Each anchor represents something a human almost never does when writing organically on LinkedIn. The goal is precision over coverage — it's better to miss some AI posts than to falsely flag human ones.

## Privacy

Everything runs locally in your browser. The extension:

- Makes **zero** network requests
- Sends **no data** to any server
- Uses only `chrome.storage.local` for your on/off preference and scan stats
- Requires only `activeTab` and `storage` permissions

## Files

```
linkedin-ai-detector/
  manifest.json    — Chrome extension manifest (MV3)
  content.js       — Detection logic and DOM manipulation
  styles.css       — Shading, dot, and tooltip styles
  popup.html       — Extension popup UI
  popup.js         — Popup toggle and stats logic
  icons/           — Extension icons (16, 48, 128px)
```

## License

MIT
