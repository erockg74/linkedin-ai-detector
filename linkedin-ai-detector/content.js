// LinkedIn AI Post Detector v2 — Content Script
// Handles DOM collapsing/expanding and relays interceptor data to background.

(function () {
  "use strict";

  // ─── Feed-page guard ──────────────────────────────────────────────────
  function isFeedPage() {
    const path = location.pathname;
    return path === "/" || path === "/feed/" || path === "/feed"
      || path.startsWith("/search/") || path.startsWith("/posts/");
  }

  // ─── State ─────────────────────────────────────────────────────────────
  const PROCESSED_ATTR = "data-ai-detector-v2";
  let threshold = 70;
  let scores = {}; // activityUrn → { score, reason }
  let apiKeyNotified = false;

  function contextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // ─── Load settings and cached scores ───────────────────────────────────
  if (!contextValid()) return;

  chrome.storage.local.get(["aiDetectorThreshold"], (res) => {
    if (!contextValid()) return;
    threshold = res.aiDetectorThreshold ?? 70;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (!contextValid()) return;
    if (changes.aiDetectorThreshold) {
      threshold = changes.aiDetectorThreshold.newValue ?? 70;
      // Re-evaluate all posts with new threshold
      reEvaluateAll();
    }
  });

  // Request all cached scores from background
  if (contextValid()) {
    try {
      chrome.runtime.sendMessage({ type: "GET_ALL_SCORES" }, (res) => {
        if (res?.scores) {
          scores = res.scores;
          applyAllScores();
        }
      });
    } catch (e) {}
  }

  // ─── Listen for messages ───────────────────────────────────────────────

  // From background: score ready
  chrome.runtime.onMessage.addListener((msg) => {
    if (!contextValid()) return;

    if (msg.type === "SCORE_READY") {
      scores[msg.activityUrn] = { score: msg.score, reason: msg.reason };
      applyScoreToPost(msg.activityUrn);
    }

    if (msg.type === "NEED_API_KEY" && !apiKeyNotified) {
      apiKeyNotified = true;
      showApiKeyNotification();
    }
  });

  // From interceptor (page context → content script via postMessage)
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "AI_DETECTOR_FEED_DATA") return;
    if (!contextValid()) return;

    // Relay to background for scoring
    try {
      chrome.runtime.sendMessage({
        type: "FEED_POSTS",
        posts: event.data.posts
      });
    } catch (e) {}
  });

  // ─── DOM operations ────────────────────────────────────────────────────

  function findPostCards() {
    // LinkedIn post cards in the feed
    return document.querySelectorAll([
      '.feed-shared-update-v2',
      '.occludable-update',
      '[data-urn]',
      '[data-id]'
    ].join(", "));
  }

  function getPostUrn(el) {
    // Try various attributes LinkedIn uses
    const urn = el.getAttribute("data-urn") ||
                el.getAttribute("data-id") ||
                el.getAttribute("data-activity-urn") || "";

    // Normalize
    const match = urn.match(/(urn:li:(?:activity|ugcPost|share):\d+)/);
    if (match) return match[1];

    // Try to find URN in nested elements
    const nested = el.querySelector("[data-urn], [data-id]");
    if (nested) {
      const nUrn = nested.getAttribute("data-urn") || nested.getAttribute("data-id") || "";
      const nMatch = nUrn.match(/(urn:li:(?:activity|ugcPost|share):\d+)/);
      if (nMatch) return nMatch[1];
    }

    return null;
  }

  function getPostText(el) {
    const textEl = el.querySelector(
      ".update-components-text, .feed-shared-text, " +
      ".feed-shared-update-v2__description, " +
      ".update-components-update-v2__commentary, " +
      ".feed-shared-inline-show-more-text"
    );
    return textEl ? (textEl.innerText || "").trim() : "";
  }

  function getAuthorName(el) {
    const actorEl = el.querySelector(
      ".update-components-actor__name, .feed-shared-actor__name"
    );
    if (actorEl) {
      // Get just the visible text, not aria-hidden spans
      const visible = actorEl.querySelector(".visually-hidden")
        ? actorEl.textContent.trim()
        : actorEl.innerText.trim();
      return visible.split("\n")[0].trim();
    }
    return "Unknown";
  }

  // ─── Collapse / Expand UI ──────────────────────────────────────────────

  function collapsePost(postEl, urn, scoreData) {
    if (postEl.getAttribute(PROCESSED_ATTR) === "collapsed") return;

    const score = scoreData.score;
    const reason = scoreData.reason;
    const author = getAuthorName(postEl);
    const text = getPostText(postEl);
    const preview = text.split(/\s+/).slice(0, 10).join(" ");

    // Create collapsed bar
    const bar = document.createElement("div");
    bar.className = "ai-detector-collapsed";
    bar.setAttribute("data-ai-urn", urn);

    // Score color
    const scoreClass = score >= 90 ? "ai-detector-score-high" :
                       score >= 70 ? "ai-detector-score-mid" :
                       "ai-detector-score-low";

    bar.innerHTML =
      `<span class="ai-detector-score ${scoreClass}">\uD83E\uDD16 ${score}%</span>` +
      `<span class="ai-detector-author">${escapeHtml(author)}</span>` +
      `<span class="ai-detector-preview">\u2014 "${escapeHtml(preview)}..."</span>` +
      `<span class="ai-detector-expand" title="${escapeHtml(reason)}">\u25BC</span>`;

    // Click to expand
    bar.addEventListener("click", () => {
      togglePost(postEl, bar, urn);
    });

    // Insert bar before post and hide post
    postEl.parentNode.insertBefore(bar, postEl);
    postEl.classList.add("ai-detector-hidden");
    postEl.setAttribute(PROCESSED_ATTR, "collapsed");

    // Animate in
    requestAnimationFrame(() => {
      bar.classList.add("ai-detector-collapsed-visible");
    });
  }

  function togglePost(postEl, bar, urn) {
    const isCollapsed = postEl.classList.contains("ai-detector-hidden");
    if (isCollapsed) {
      postEl.classList.remove("ai-detector-hidden");
      postEl.classList.add("ai-detector-revealed");
      bar.querySelector(".ai-detector-expand").textContent = "\u25B2";
      postEl.setAttribute(PROCESSED_ATTR, "expanded");
    } else {
      postEl.classList.add("ai-detector-hidden");
      postEl.classList.remove("ai-detector-revealed");
      bar.querySelector(".ai-detector-expand").textContent = "\u25BC";
      postEl.setAttribute(PROCESSED_ATTR, "collapsed");
    }
  }

  function uncollapsePost(postEl) {
    // Remove collapsed bar if it exists
    const bar = postEl.previousElementSibling;
    if (bar && bar.classList.contains("ai-detector-collapsed")) {
      bar.remove();
    }
    postEl.classList.remove("ai-detector-hidden", "ai-detector-revealed");
    postEl.removeAttribute(PROCESSED_ATTR);
  }

  // ─── Apply scores to DOM ───────────────────────────────────────────────

  function applyScoreToPost(urn) {
    if (!isFeedPage()) return;
    const scoreData = scores[urn];
    if (!scoreData) return;

    const cards = findPostCards();
    for (const card of cards) {
      const cardUrn = getPostUrn(card);
      if (cardUrn === urn) {
        if (scoreData.score >= threshold) {
          collapsePost(card, urn, scoreData);
        }
        break;
      }
    }
  }

  function applyAllScores() {
    if (!isFeedPage()) return;
    const cards = findPostCards();
    for (const card of cards) {
      const urn = getPostUrn(card);
      if (!urn) continue;
      if (card.getAttribute(PROCESSED_ATTR)) continue;

      const scoreData = scores[urn];
      if (scoreData && scoreData.score >= threshold) {
        collapsePost(card, urn, scoreData);
      }
    }
  }

  function reEvaluateAll() {
    if (!isFeedPage()) return;
    // Remove all current collapse bars and reset
    document.querySelectorAll(".ai-detector-collapsed").forEach((bar) => bar.remove());
    document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
      el.classList.remove("ai-detector-hidden", "ai-detector-revealed");
      el.removeAttribute(PROCESSED_ATTR);
    });
    // Re-apply with new threshold
    applyAllScores();
  }

  // ─── Scan for new posts (unscored) ─────────────────────────────────────
  // If the interceptor missed a post or it was rendered from cache,
  // extract text from the DOM and send to background for scoring.

  function scanForUnscoredPosts() {
    if (!isFeedPage()) return;
    const cards = findPostCards();
    const newPosts = [];

    for (const card of cards) {
      const urn = getPostUrn(card);
      if (!urn) continue;
      if (scores[urn]) continue; // Already scored
      if (card.getAttribute(PROCESSED_ATTR)) continue;

      const text = getPostText(card);
      if (text.length < 20) continue;

      newPosts.push({
        activityUrn: urn,
        text: text,
        author: getAuthorName(card)
      });
    }

    if (newPosts.length > 0 && contextValid()) {
      try {
        chrome.runtime.sendMessage({ type: "FEED_POSTS", posts: newPosts });
      } catch (e) {}
    }
  }

  // ─── API key notification ──────────────────────────────────────────────

  function showApiKeyNotification() {
    const notif = document.createElement("div");
    notif.className = "ai-detector-notification";
    notif.innerHTML =
      '<span>\uD83E\uDD16 LinkedIn AI Detector: Please add your Anthropic API key in the extension settings.</span>' +
      '<button class="ai-detector-notif-close">\u2715</button>';
    notif.querySelector("button").addEventListener("click", () => notif.remove());
    document.body.appendChild(notif);
    setTimeout(() => {
      if (notif.parentNode) notif.remove();
    }, 10000);
  }

  // ─── Utility ───────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }

  // ─── MutationObserver ──────────────────────────────────────────────────

  let observer = null;
  let scanDebounce = null;

  function boot() {
    // Initial scan
    applyAllScores();
    scanForUnscoredPosts();

    if (observer) return;

    observer = new MutationObserver(() => {
      if (!contextValid()) { teardown(); return; }
      clearTimeout(scanDebounce);
      scanDebounce = setTimeout(() => {
        applyAllScores();
        scanForUnscoredPosts();
      }, 500);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function teardown() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // ─── Start when DOM is ready ───────────────────────────────────────────

  if (document.body) {
    boot();
  } else {
    document.addEventListener("DOMContentLoaded", boot);
  }

  // Handle SPA navigation
  let lastPath = location.pathname;
  setInterval(() => {
    if (!contextValid()) { teardown(); return; }
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      if (isFeedPage()) {
        applyAllScores();
        scanForUnscoredPosts();
      }
    }
  }, 2000);

})();
