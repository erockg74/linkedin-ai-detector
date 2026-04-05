# LinkedIn AI Post Detector

A Chrome extension that scores LinkedIn posts for AI-generated content using Claude Haiku. Bring your own Anthropic API key.

## How it works

The extension finds posts in your LinkedIn feed and activity pages, extracts their text, and sends each one to Claude Haiku for scoring. Every post gets an AI confidence score (0–100%) displayed as a color-coded pill badge inline with the post header. While a score is being fetched, a pulsing spinner pill is shown. Posts above your chosen threshold are collapsed on the main feed — you still see who posted it, but the content and action buttons are hidden behind a gray overlay. Click the toggle arrow to expand any collapsed post.

Hover over any score badge to see a short AI assessment and a TL;DR summary of the post. This lets you quickly understand what a post is about — especially useful for collapsed posts where the content is hidden.

### Badge states

- **Spinner pill** (amber) — scoring in progress
- **Score pill** (green/amber/red) — scored, with color indicating AI likelihood
- **Grey pill** — not enough text to assess, or non-post content (ads, job listings)

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

The extension uses an anchor-first DOM discovery approach. Instead of relying on LinkedIn's CSS classes, data attributes, or ARIA roles (which change frequently), it finds posts using stable visual anchors:

**Feed pages** (`/`, `/feed`, `/search/*`, `/posts/*`):

1. **⋯ + ✕ dismiss pair** — two adjacent icon-only buttons near the top of every post card. Walking up from the pair to the first ancestor containing other pairs gives the post boundary.
2. **"… more" button** — the truncated-post expand button. Its parent contains clean post text.
3. **Direct text fallback** — when LinkedIn uses obfuscated class names, the extension extracts `innerText` directly from the post boundary with noise filtering.

**Activity pages** (`/in/*/recent-activity/*`):

1. **`data-urn` elements** — each `div[data-urn*="activity"]` is the post card directly (no boundary walking needed).
2. **Control menu button** — the single ⋯ button anchors badge placement via a synthesized "virtual pair."

SPA navigation is detected via `history.pushState`/`replaceState` interception, `popstate`, and `visibilitychange` listeners with multi-scan retries on navigation. When navigating to an activity page via SPA (e.g. "Show all →"), the extension forces a page reload because LinkedIn's SPA renders activity pages using their SDUI framework with an incompatible DOM structure. The reload triggers the classic server-rendered DOM that the extension can parse. Self-healing diagnostics log a console warning when detection stops working, and pending posts auto-retry if the service worker connection is lost.

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

Each post costs roughly one Claude Haiku API call. At current pricing this is fractions of a cent per post (~$0.0004 per post). Posts are scored in parallel (up to 5 concurrent calls) and scores are cached for the browser session.

## License

MIT
