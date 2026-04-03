// LinkedIn AI Post Detector v2.1 — Service Worker (background.js)
// Receives posts from content script (DOM-detected), scores via Haiku, stores results.
// postKey can be a URN (urn:li:activity:...) or a text hash (txh:...).

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const HAIKU_MAX_TOKENS = 100;

const SCORING_PROMPT = `You are evaluating whether a LinkedIn post was likely written by AI (ChatGPT, Claude, etc.) or by a human.

Consider:
- Does it contain specific personal experience or generic advice?
- Is the structure formulaic (hook, bullets, CTA)?
- Does it use buzzwords without substance?
- Does it have genuine personality, humor, or controversy?
- Is the grammar suspiciously perfect with no voice?
- Could anyone have written this, or does it sound like a specific person?

Post text:
"""
{post_text}
"""

Respond with JSON only: {"score": 0-100, "reason": "one sentence"}
Score 0 = definitely human, 100 = definitely AI.
IMPORTANT: Only use score -1 for text that is clearly NOT a user-authored post — for example, a standalone ad unit, job listing card, or LinkedIn UI element with zero user-written content. Posts that share articles, link to news stories, or include quoted material ARE still user posts — score them normally based on whatever commentary or framing the author added. When in doubt, score it.
If the text is genuinely not a post, respond with: {"score": -1, "reason": "Not a post"}`;

// Track posts currently being scored to avoid duplicates
const pendingScores = new Set();
// In-memory score cache (also persisted to session storage)
const scoreCache = new Map();

// Stats tracking
let stats = { scanned: 0, collapsed: 0 };

// Load stats on startup
chrome.storage.local.get(["aiDetectorStats"], (res) => {
  if (res.aiDetectorStats) stats = res.aiDetectorStats;
});

// ─── Haiku API call ──────────────────────────────────────────────────────

async function scorePost(postText, postKey, apiKey) {
  if (pendingScores.has(postKey) || scoreCache.has(postKey)) return;
  pendingScores.add(postKey);

  try {
    const prompt = SCORING_PROMPT.replace("{post_text}", postText);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: HAIKU_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      console.warn(`[AI Detector] Haiku API error: ${response.status}`);
      return;
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    // Parse JSON from response (handle markdown code blocks)
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    const result = JSON.parse(cleaned);
    const rawScore = parseInt(result.score, 10);
    // -1 = "not a post" → pass through as-is; otherwise clamp 0–100
    const score = rawScore === -1 ? -1 : Math.max(0, Math.min(100, rawScore));
    const reason = result.reason || "";

    const scoreData = { score, reason, postKey, timestamp: Date.now() };
    scoreCache.set(postKey, scoreData);

    // Persist to session storage
    const storageKey = `score_${postKey}`;
    const storageUpdate = {};
    storageUpdate[storageKey] = scoreData;
    chrome.storage.session.set(storageUpdate);

    // Update stats
    stats.scanned++;
    const settings = await chrome.storage.local.get(["aiDetectorThreshold"]);
    const threshold = settings.aiDetectorThreshold ?? 70;
    if (score >= threshold) stats.collapsed++;
    chrome.storage.local.set({ aiDetectorStats: stats });

    // Broadcast score to all LinkedIn tabs
    const tabs = await chrome.tabs.query({ url: "*://*.linkedin.com/*" });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: "SCORE_READY",
        postKey,
        score,
        reason
      }).catch(() => {
        // Tab might not have content script yet — safe to ignore
      });
    }
  } catch (e) {
    console.warn(`[AI Detector] Scoring failed for ${postKey}:`, e);
    // Fail open — leave post visible
  } finally {
    pendingScores.delete(postKey);
  }
}

// ─── Message handler ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FEED_POSTS") {
    handleFeedPosts(msg.posts);
    sendResponse({ ok: true });
  }

  if (msg.type === "GET_ALL_SCORES") {
    const allScores = {};
    for (const [key, data] of scoreCache) {
      allScores[key] = data;
    }
    sendResponse({ scores: allScores });
    return true;
  }

  if (msg.type === "GET_STATS") {
    sendResponse({ stats });
    return true;
  }

  if (msg.type === "RESET_STATS") {
    stats = { scanned: 0, collapsed: 0 };
    chrome.storage.local.set({ aiDetectorStats: stats });
    sendResponse({ ok: true });
  }
});

async function handleFeedPosts(posts) {
  if (!posts || !posts.length) return;

  const settings = await chrome.storage.local.get(["aiDetectorApiKey"]);
  const apiKey = settings.aiDetectorApiKey;

  if (!apiKey) {
    if (!handleFeedPosts._notified) {
      handleFeedPosts._notified = true;
      const tabs = await chrome.tabs.query({ url: "*://*.linkedin.com/*", active: true });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "NEED_API_KEY" }).catch(() => {});
      }
    }
    return;
  }

  for (const post of posts) {
    if (!post.postKey || !post.text) continue;
    if (post.text.trim().length < 20) continue;
    if (scoreCache.has(post.postKey)) continue;
    await scorePost(post.text, post.postKey, apiKey);
  }
}

// ─── Restore scores from session storage on startup ──────────────────────

chrome.storage.session.get(null, (items) => {
  for (const [key, value] of Object.entries(items)) {
    if (key.startsWith("score_") && value.postKey) {
      scoreCache.set(value.postKey, value);
    }
  }
});

// ─── Re-inject content script on SPA navigation ─────────────────────────
// LinkedIn is an SPA. The content script runs once at document_idle, but
// its execution context can become stale after SPA navigation. We listen
// for URL changes on LinkedIn tabs and re-inject content.js + styles.css
// when the context is dead. This is the only reliable way to ensure the
// detector works on activity pages reached via in-app navigation.

const injectedTabs = new Map(); // tabId → last injected URL

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only act on URL changes to LinkedIn pages
  if (!changeInfo.url) return;
  if (!changeInfo.url.includes("linkedin.com")) return;

  // Debounce: skip if we just injected for this exact URL
  if (injectedTabs.get(tabId) === changeInfo.url) return;

  // Small delay to let the page settle after SPA navigation
  setTimeout(async () => {
    try {
      // Ping the content script to see if it's alive
      const response = await chrome.tabs.sendMessage(tabId, { type: "PING" })
        .catch(() => null);

      if (response && response.pong) {
        // Content script is alive — no need to re-inject
        return;
      }

      // Content script is dead — re-inject
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["styles.css"]
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      injectedTabs.set(tabId, changeInfo.url);
    } catch (e) {
      // Tab may have closed or navigated away — safe to ignore
    }
  }, 500);
});

// Clean up closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});
