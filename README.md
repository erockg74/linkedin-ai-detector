# LinkedIn AI Post Detector

A Chrome extension that scores LinkedIn posts for AI-generated content using Claude Haiku. Bring your own Anthropic API key.

## How it works

The extension finds posts in your LinkedIn feed, extracts their text, and sends each one to Claude Haiku for scoring. Every post gets an AI confidence score (0–100%) displayed as a badge inline with the post. Posts above your chosen threshold are collapsed — you still see who posted it, but the content and action buttons are hidden behind a gray overlay. Click the toggle arrow to expand any collapsed post.

Hover over any score badge to see a short explanation of why the post was flagged.

## Installation

1. Clone this repo or download the ZIP
2. Open `chrome://extensions/` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `linkedin-ai-detector` folder (the one containing `manifest.json`)
6. Click the extension icon and enter your Anthropic API key
7. Navigate to LinkedIn — scoring starts automatically

## Controls

The popup gives you three filter presets plus a fine-tuning slider:

- **Aggressive** — collapses most AI-suspected posts (threshold 30)
- **Permissive** — only collapses obvious AI posts (threshold 70)
- **Off** — scores are still shown on every post, but nothing is collapsed

The slider lets you dial in anywhere between aggressive and permissive. Changes take effect after a 2-second debounce — no API re-calls, just re-evaluation of cached scores.

## Architecture

The extension uses an anchor-first DOM discovery approach. Instead of relying on LinkedIn's CSS classes, data attributes, or ARIA roles (which change frequently), it finds posts using two stable visual anchors:

1. **"… more" button** — the truncated-post expand button. Its parent contains the post text.
2. **⋯ + ✕ dismiss pair** — two adjacent icon-only buttons near the top of every post card. Walking up from "… more" to the first ancestor containing this pair gives the post boundary.

This makes the extension resilient to LinkedIn's frequent DOM restructuring. Additional hardening includes adaptive layout detection (dual-anchor section splitting instead of fixed child counts), fallback author detection (link + avatar image pattern if `/in/` URLs change), and self-healing diagnostics that log a console warning when detection stops working.

## Files

```
linkedin-ai-detector/
  manifest.json    — Chrome extension manifest (MV3)
  content.js       — Anchor-first post detection, scoring UI, collapse/expand
  background.js    — Claude Haiku API calls, score caching via chrome.storage.session
  styles.css       — Badge, tooltip, collapse overlay, and notification styles
  popup.html       — Extension popup with API key input and filter controls
  popup.js         — Preset buttons, slider logic, stats display
  icons/           — Extension icons (16, 48, 128px)
```

## Privacy

Post text is sent to the Anthropic API for scoring using your own API key. No data is sent anywhere else. Scores are cached in your browser's session storage so posts aren't re-scored on page navigation.

## Cost

Each post costs roughly one Claude Haiku API call. At current pricing this is fractions of a cent per post. Posts are scored sequentially to avoid rate limiting, and scores are cached for the browser session.

## License

MIT
