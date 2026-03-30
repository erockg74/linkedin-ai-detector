# LinkedIn AI Post Detector

A Chrome extension that scores LinkedIn posts for AI-generated content using Claude Haiku. Bring your own Anthropic API key.

## How it works

The extension finds posts in your LinkedIn feed, extracts their text, and sends each one to Claude Haiku for scoring. Every post gets an AI confidence score displayed as a unified pill badge (e.g. "AI 72%") inline with the post controls. The pill is color-coded: red for high scores, amber for mid-range, and green for low. Posts above your chosen threshold are collapsed — you still see who posted it, but the content and action buttons are hidden behind a gray overlay. Click the toggle arrow inside the pill to expand any collapsed post.

Posts with too little text to assess (image-only, emoji-only, etc.) get a dimmed "AI –" pill so you know the extension saw them but couldn't score them. Hover over that pill to see "Not enough text to assess."

Hover over any scored pill to see a short explanation of why the post was flagged.

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

1. **⋯ + ✕ dismiss pair** (primary anchor) — two adjacent icon-only buttons near the top of every post card. Every post has exactly one pair, and they never nest. Walking up from the pair until the parent contains other pairs gives the post boundary — a 1:1 mapping with no dedup needed.
2. **"… more" button** (secondary anchor) — the truncated-post expand button. When present, its parent contains clean post text. When absent, text is extracted from content sections between the header and actions bar.

This makes the extension resilient to LinkedIn's frequent DOM restructuring. Additional hardening includes an invisible-wrapper fix (walks down through zero-height single-child containers), adaptive content section detection, noise filtering (strips author sections, engagement stats, and inline comments), and self-healing diagnostics that log a console warning after three consecutive zero-result scans.

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
