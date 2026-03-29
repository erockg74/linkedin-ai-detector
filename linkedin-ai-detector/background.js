// LinkedIn AI Post Detector v2 — Service Worker (background.js)
// Receives intercepted feed data from content script, scores via Haiku, stores results.

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
Score 0 = definitely human, 100 = definitely AI.`;

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

async function scorePost(postText, activityUrn, apiKey) {
  if (pendingScores.has(activityUrn) || scoreCache.has(activityUrn)) return;
  pendingScores.add(activityUrn);

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
    const score = Math.max(0, Math.min(100, parseInt(result.score, 10)));
    const reason = result.reason || "";

    const scoreData = { score, reason, activityUrn, timestamp: Date.now() };
    scoreCache.set(activityUrn, scoreData);

    // Persist to session storage
    const storageUpdate = {};
    storageUpdate[`score_${activityUrn}`] = scoreData;
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
      try {
        chrome.tabs.sendMessage(tab.id, {
          type: "SCORE_READY",
          activityUrn,
          score,
          reason
        });
      } catch (e) {
        // Tab might not have content script yet
      }
    }
  } catch (e) {
    console.warn(`[AI Detector] Scoring failed for ${activityUrn}:`, e);
    // Fail open — leave post visible
  } finally {
    pendingScores.delete(activityUrn);
  }
}

// ─── Message handler ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "FEED_POSTS") {
    // Received extracted posts from content script (via interceptor)
    handleFeedPosts(msg.posts);
    sendResponse({ ok: true });
  }

  if (msg.type === "GET_ALL_SCORES") {
    // Content script requesting all cached scores
    const allScores = {};
    for (const [urn, data] of scoreCache) {
      allScores[urn] = data;
    }
    sendResponse({ scores: allScores });
    return true; // keep channel open for async
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
    // Notify user to set API key (once per session)
    if (!handleFeedPosts._notified) {
      handleFeedPosts._notified = true;
      const tabs = await chrome.tabs.query({ url: "*://*.linkedin.com/*", active: true });
      for (const tab of tabs) {
        try {
          chrome.tabs.sendMessage(tab.id, { type: "NEED_API_KEY" });
        } catch (e) {}
      }
    }
    return;
  }

  for (const post of posts) {
    if (!post.activityUrn || !post.text) continue;
    if (post.text.trim().length < 20) continue;
    // Don't re-score
    if (scoreCache.has(post.activityUrn)) continue;
    scorePost(post.text, post.activityUrn, apiKey);
  }
}

// ─── Inject interceptor into LinkedIn tabs ───────────────────────────────

// Inject on navigation
chrome.webNavigation?.onCommitted?.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!details.url.includes("linkedin.com")) return;
  injectInterceptor(details.tabId);
});

// Also inject on tab update (for SPA navigations)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && tab.url?.includes("linkedin.com")) {
    injectInterceptor(tabId);
  }
});

function injectInterceptor(tabId) {
  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: ["interceptor.js"]
  }).catch(() => {
    // May fail if tab isn't ready yet, that's ok
  });
}

// ─── Restore scores from session storage on startup ──────────────────────

chrome.storage.session.get(null, (items) => {
  for (const [key, value] of Object.entries(items)) {
    if (key.startsWith("score_") && value.activityUrn) {
      scoreCache.set(value.activityUrn, value);
    }
  }
});
