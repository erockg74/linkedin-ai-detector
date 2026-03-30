// LinkedIn AI Post Detector v2.5 — Content Script
// Anchor-first approach: the ⋯ + ✕ dismiss button pair is the PRIMARY anchor.
//   1. ⋯ + ✕ dismiss pair → exists on EVERY post card, never nests.
//      Walk UP from the pair until the parent contains other pairs.
//      That ancestor is the post boundary (1:1 mapping, no dedup needed).
//   2. "… more" button → SECONDARY anchor for clean text extraction.
//      When present, use its parent for post text. When absent, extract
//      text from content sections between header and actions bar.
// No convergence, no depth counting, no role/class selectors.

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
  const MORE_TEXT = "\u2026 more";   // "… more" — the visible button text
  let threshold = 70;
  let scores = {};           // postKey → { score, reason }
  let apiKeyNotified = false;
  let zeroResultCount = 0;        // consecutive scans with zero posts found
  let diagnosticNotified = false;  // only warn once per page load

  function contextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  // ─── Simple text hash for keying posts without URNs ────────────────────
  function hashText(str) {
    let hash = 0;
    const s = str.substring(0, 200);
    for (let i = 0; i < s.length; i++) {
      hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return "txh:" + (hash >>> 0).toString(36);
  }

  // ─── PRIMARY ANCHOR: find ALL ⋯ + ✕ dismiss pairs on the page ────────
  // Two consecutive sibling buttons, both SVG-only (no text), visible.
  // Returns an array of { dotsBtn, dismissBtn, controlRow }.

  function findAllDismissPairs() {
    const pairs = [];
    for (const btn of document.querySelectorAll("button")) {
      if (!btn.querySelector("svg")) continue;
      if (btn.textContent.trim().length > 0) continue;
      if (btn.getBoundingClientRect().width === 0) continue;

      const next = btn.nextElementSibling;
      if (!next || next.tagName !== "BUTTON") continue;
      if (!next.querySelector("svg")) continue;
      if (next.textContent.trim().length > 0) continue;
      if (next.getBoundingClientRect().width === 0) continue;

      pairs.push({ dotsBtn: btn, dismissBtn: next, controlRow: btn.parentElement });
    }
    return pairs;
  }

  // ─── Find the ⋯ + ✕ dismiss pair inside a known post boundary ────────
  // Used by injectBadge, collapsePost, etc. when we already have the card.
  function findDismissPair(el) {
    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0) return null;

    for (const btn of el.querySelectorAll("button")) {
      if (!btn.querySelector("svg")) continue;
      if (btn.textContent.trim().length > 0) continue;
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.top > elRect.top + 120) continue;

      const next = btn.nextElementSibling;
      if (!next || next.tagName !== "BUTTON") continue;
      if (!next.querySelector("svg")) continue;
      if (next.textContent.trim().length > 0) continue;
      if (next.getBoundingClientRect().width === 0) continue;

      return { dotsBtn: btn, dismissBtn: next, controlRow: btn.parentElement };
    }
    return null;
  }

  // ─── Post boundary: walk UP from dismiss pair to the post card ────────
  // The boundary is the ancestor whose PARENT contains other dismiss pairs
  // not inside this ancestor. That parent is the feed container; this
  // ancestor is the individual post card. 1:1 mapping, no dedup needed.

  function findPostCard(pair, allPairs) {
    let node = pair.controlRow;
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      for (const p of allPairs) {
        if (p === pair) continue;
        if (parent.contains(p.dotsBtn) && !node.contains(p.dotsBtn)) {
          // Found the boundary. LinkedIn wraps cards in invisible containers
          // (height/width 0). If this node is invisible, walk DOWN to the
          // first visible descendant that still contains the dismiss pair.
          if (node.getBoundingClientRect().height === 0) {
            let visible = node;
            while (visible.children.length === 1 && visible.firstElementChild) {
              const child = visible.firstElementChild;
              if (child.getBoundingClientRect().height > 0 && child.contains(pair.dotsBtn)) {
                visible = child;
              } else {
                break;
              }
            }
            return visible;
          }
          return node;
        }
      }
      node = parent;
    }
    return node;
  }

  // ─── SECONDARY ANCHOR: find "… more" button inside a post card ────────
  // When present, its parent element contains the clean post text.
  function findMoreButton(card) {
    for (const btn of card.querySelectorAll("button")) {
      if (btn.textContent.trim() === MORE_TEXT) return btn;
    }
    return null;
  }

  // ─── Section classification helpers ───────────────────────────────────

  // Engagement stats row: "N reactions", "N comments", "N reposts"
  function isEngagementSection(section) {
    const text = section.innerText.trim();
    if (text.length === 0 || text.length > 150) return false;
    // Matches patterns like "5", "5 reactions", "2 comments", "1 repost"
    return /(?:^\d|reaction|comment|repost)/i.test(text);
  }

  // Inline comment: contains a profile link + "Like" + "Reply" text
  function isInlineComment(section) {
    const text = section.innerText;
    if (!text.includes("Reply")) return false;
    const hasProfileLink = section.querySelector('a[href*="/in/"]') ||
      (section.querySelector("a") && section.querySelector("img"));
    return !!hasProfileLink;
  }

  // Author section: profile link with visible name (with fallback)
  function isAuthorSection(section) {
    const profileLinks = section.querySelectorAll('a[href*="/in/"]');
    for (const a of profileLinks) {
      const name = a.innerText.trim().split("\n")[0].trim();
      if (name.length > 2 && name.length < 80) return true;
    }
    if (section.querySelector("a") && section.querySelector("img")) {
      const links = section.querySelectorAll("a");
      for (const a of links) {
        const name = a.innerText.trim().split("\n")[0].trim();
        if (name.length > 2 && name.length < 80) return true;
      }
    }
    return false;
  }

  // ─── Text extraction ─────────────────────────────────────────────────
  // Strategy: if "… more" exists, use its parent for clean text (proven).
  // Otherwise, pull text from content sections, skipping author,
  // engagement stats, inline comments, and empty sections.

  function extractPostText(card, pair) {
    // Preferred: "… more" button gives us clean text
    const moreBtn = findMoreButton(card);
    if (moreBtn) {
      const textContainer = moreBtn.parentElement;
      if (textContainer) {
        const clone = textContainer.cloneNode(true);
        for (const b of clone.querySelectorAll("button")) b.remove();
        const text = clone.innerText.trim();
        if (text.length >= 20) return text;
      }
    }

    // Fallback: extract from content sections
    const sections = getContentSections(card, pair);
    if (!sections) return "";

    let text = "";
    for (const section of sections.content) {
      if (isAuthorSection(section)) continue;
      if (isEngagementSection(section)) continue;
      if (isInlineComment(section)) continue;
      const sectionText = section.innerText.trim();
      if (sectionText.length === 0) continue;
      text += sectionText + "\n";
    }
    return text.trim();
  }

  // ─── Get post key (URN or text hash) from the post boundary ───────────
  function getPostKey(boundary, text) {
    const urnLinks = boundary.querySelectorAll(
      'a[href*="urn:li:activity"], a[href*="urn:li:share"], a[href*="urn:li:ugcPost"]'
    );
    for (const a of urnLinks) {
      const m = a.href.match(/(urn:li:(?:activity|ugcPost|share):\d+)/);
      if (m) return m[1];
    }
    const updateLinks = boundary.querySelectorAll('a[href*="/feed/update/"]');
    for (const a of updateLinks) {
      const m = a.href.match(/(urn:li:(?:activity|ugcPost|share):\d+)/);
      if (m) return m[1];
    }
    return hashText(text);
  }

  // ─── Get author from profile links in the post boundary ───────────────
  function getAuthor(boundary) {
    const profileLinks = boundary.querySelectorAll('a[href*="/in/"]');
    for (const pl of profileLinks) {
      const name = pl.innerText.trim().split("\n")[0].trim();
      if (name && name.length > 2 && name.length < 60) return name;
    }
    const imgs = boundary.querySelectorAll("img");
    for (const img of imgs) {
      const parent = img.closest("a")?.parentElement || img.parentElement;
      if (!parent) continue;
      const links = parent.querySelectorAll("a");
      for (const a of links) {
        const name = a.innerText.trim().split("\n")[0].trim();
        if (name && name.length > 2 && name.length < 60) return name;
      }
    }
    return "Unknown";
  }

  // ─── Find unprocessed posts ────────────────────────────────────────────
  // Primary anchor: ⋯ + ✕ dismiss pair. Every post has one, never nests.
  function findPosts() {
    const allPairs = findAllDismissPairs();
    if (allPairs.length === 0) return [];

    const results = [];

    for (const pair of allPairs) {
      const boundary = findPostCard(pair, allPairs);
      if (!boundary) continue;
      if (boundary.getAttribute(PROCESSED_ATTR)) continue;

      const text = extractPostText(boundary, pair);
      if (text.length < 20) {
        // Not enough text to score — inject dimmed "AI –" pill and mark done
        injectUnscoredBadge(boundary, pair);
        boundary.setAttribute(PROCESSED_ATTR, "unscored");
        continue;
      }

      const postKey = getPostKey(boundary, text);
      const author = getAuthor(boundary);

      results.push({ boundary, pair, postKey, text, author });
    }

    return results;
  }

  // ─── Scan and apply ───────────────────────────────────────────────────

  function scanAndApply() {
    if (!isFeedPage()) return;
    if (!contextValid()) return;

    const posts = findPosts();
    const newPosts = [];

    // ─── Self-healing diagnostics ─────────────────────────────────────
    if (posts.length === 0 && !diagnosticNotified) {
      const hasContent = document.body.scrollHeight > window.innerHeight * 1.5;
      const hasButtons = document.querySelectorAll("button").length > 10;
      if (hasContent && hasButtons) {
        zeroResultCount++;
        if (zeroResultCount >= 3) {
          diagnosticNotified = true;
          const allPairs = findAllDismissPairs();
          console.warn(
            "[AI Detector] Diagnostic: 0 posts detected after",
            zeroResultCount, "scans on a page with content.",
            "LinkedIn may have changed their DOM structure.",
            "\n  - Dismiss pairs found:", allPairs.length,
            "\n  - Post cards resolved:", (() => {
              const seen = new Set();
              for (const p of allPairs) {
                const card = findPostCard(p, allPairs);
                if (card) seen.add(card);
              }
              return seen.size;
            })()
          );
        }
      }
    } else if (posts.length > 0) {
      zeroResultCount = 0;
    }

    for (const { boundary, pair, postKey, text, author } of posts) {
      if (scores[postKey]) {
        injectBadge(boundary, postKey, scores[postKey]);
        if (scores[postKey].score >= threshold) {
          collapsePost(boundary, postKey);
        }
        boundary.setAttribute(PROCESSED_ATTR, scores[postKey].score >= threshold ? "collapsed" : "scored");
        continue;
      }

      newPosts.push({ postKey, text, author });
      boundary.setAttribute(PROCESSED_ATTR, "pending");
    }

    if (newPosts.length > 0) {
      try {
        chrome.runtime.sendMessage(
          { type: "FEED_POSTS", posts: newPosts },
          () => { void chrome.runtime.lastError; }
        );
      } catch (e) {
        console.warn("[AI Detector] sendMessage error:", e);
      }
    }
  }

  // ─── Apply a single score (callback from background) ──────────────────

  function applyScoreToPost(postKey) {
    if (!isFeedPage()) return;
    const scoreData = scores[postKey];
    if (!scoreData) return;

    const allPairs = findAllDismissPairs();

    for (const pair of allPairs) {
      const boundary = findPostCard(pair, allPairs);
      if (!boundary) continue;

      const text = extractPostText(boundary, pair);
      const thisKey = getPostKey(boundary, text);

      if (thisKey === postKey) {
        injectBadge(boundary, postKey, scoreData);
        if (scoreData.score >= threshold) {
          collapsePost(boundary, postKey);
        }
        boundary.setAttribute(PROCESSED_ATTR, scoreData.score >= threshold ? "collapsed" : "scored");
      }
    }
  }

  // ─── Collapse / Expand UI ──────────────────────────────────────────────
  // The ⋯ + ✕ pair's controlRow = header area → keep visible
  // Walk UP from controlRow to find the container holding both header
  // and actions bar (two functional anchors, no child-count assumption)
  // Everything between header and action bar = content → hide

  // ─── Inject badge on every scored post ──────────────────────────────
  // ─── Inject dimmed "AI –" pill for posts with too little text to score ──
  function injectUnscoredBadge(postEl, pair) {
    if (postEl.querySelector(".ai-detector-badge")) return;
    if (!pair) { pair = findDismissPair(postEl); }
    if (!pair) return;

    const badge = document.createElement("div");
    badge.className = "ai-detector-badge";
    badge.innerHTML =
      `<span class="ai-detector-score ai-detector-score-unscored">` +
        `<span class="ai-detector-ai-label">AI</span>\u2013` +
      `</span>`;

    const scoreSpan = badge.querySelector(".ai-detector-score");
    scoreSpan.addEventListener("mouseenter", () => showTooltip(scoreSpan, "Not enough text to assess"));
    scoreSpan.addEventListener("mouseleave", hideTooltip);

    pair.controlRow.insertBefore(badge, pair.dotsBtn);
  }

  function injectBadge(postEl, postKey, scoreData) {
    if (postEl.querySelector(".ai-detector-badge")) return;

    const pair = findDismissPair(postEl);
    if (!pair) return;

    const score = scoreData.score;
    const reason = scoreData.reason;

    const scoreClass = score >= 90 ? "ai-detector-score-high" :
                       score >= 70 ? "ai-detector-score-mid" :
                       "ai-detector-score-low";

    const badge = document.createElement("div");
    badge.className = "ai-detector-badge";
    badge.setAttribute("data-ai-key", postKey);
    badge.innerHTML =
      `<span class="ai-detector-score ${scoreClass}">` +
        `<span class="ai-detector-ai-label">AI</span>${score}%` +
        `<button class="ai-detector-toggle" aria-label="Toggle AI-flagged post" style="display:none">\u25BC</button>` +
      `</span>`;

    badge.addEventListener("mousedown", (e) => e.stopPropagation(), true);
    badge.querySelector(".ai-detector-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      togglePost(postEl);
    }, true);

    const scoreSpan = badge.querySelector(".ai-detector-score");
    scoreSpan.addEventListener("mouseenter", () => showTooltip(scoreSpan, reason));
    scoreSpan.addEventListener("mouseleave", hideTooltip);

    pair.controlRow.insertBefore(badge, pair.dotsBtn);
  }

  // ─── Collapse post (only when above threshold) ────────────────────────
  function collapsePost(postEl, postKey) {
    if (postEl.getAttribute(PROCESSED_ATTR) === "collapsed") return;

    const toggle = postEl.querySelector(".ai-detector-toggle");
    if (toggle) toggle.style.display = "";

    const pair = findDismissPair(postEl);
    if (!pair) return;

    const { content, actions } = getContentSections(postEl, pair);
    for (const section of content) {
      if (isAuthorSection(section)) continue;
      section.classList.add("ai-detector-section-hidden");
    }
    for (const section of actions) {
      section.classList.add("ai-detector-section-hidden");
    }

    postEl.setAttribute(PROCESSED_ATTR, "collapsed");
  }

  // ─── Find the actions bar anchor (Like/Comment/Repost/Send) ────────
  function findActionsChild(container, afterIdx) {
    const sections = Array.from(container.children);
    for (let i = sections.length - 1; i > afterIdx; i--) {
      const btns = sections[i].querySelectorAll("button");
      if (btns.length >= 3) return i;
    }
    return sections.length;
  }

  function getContentSections(postEl, pair) {
    if (!pair) pair = findDismissPair(postEl);
    if (!pair) return { header: [], content: [], actions: [] };

    let headerChild = pair.controlRow;
    let container = null;
    let headerIdx = -1;

    while (headerChild.parentElement && postEl.contains(headerChild.parentElement)) {
      const parent = headerChild.parentElement;
      const siblings = Array.from(parent.children);
      const idx = siblings.indexOf(headerChild);

      if (idx === -1) { headerChild = parent; continue; }

      const actionsIdx = findActionsChild(parent, idx);
      if (actionsIdx < siblings.length) {
        container = parent;
        headerIdx = idx;
        break;
      }

      if (siblings.length >= 4) {
        container = parent;
        headerIdx = idx;
        break;
      }

      headerChild = parent;
    }

    if (!container || headerIdx === -1) return { header: [], content: [], actions: [] };

    const sections = Array.from(container.children);
    const actionsIdx = findActionsChild(container, headerIdx);

    return {
      header: sections.slice(0, headerIdx + 1),
      content: sections.slice(headerIdx + 1, actionsIdx),
      actions: sections.slice(actionsIdx)
    };
  }

  function togglePost(postEl) {
    const isCollapsed = postEl.getAttribute(PROCESSED_ATTR) === "collapsed";
    const badge = postEl.querySelector(".ai-detector-badge");
    const toggleBtn = badge?.querySelector(".ai-detector-toggle");
    const { content, actions } = getContentSections(postEl, null);

    if (isCollapsed) {
      for (const section of content) {
        section.classList.remove("ai-detector-section-hidden");
      }
      for (const section of actions) {
        section.classList.remove("ai-detector-section-hidden");
      }
      if (toggleBtn) toggleBtn.textContent = "\u25B2";
      postEl.setAttribute(PROCESSED_ATTR, "expanded");
    } else {
      for (const section of content) {
        if (isAuthorSection(section)) continue;
        section.classList.add("ai-detector-section-hidden");
      }
      for (const section of actions) {
        section.classList.add("ai-detector-section-hidden");
      }
      if (toggleBtn) toggleBtn.textContent = "\u25BC";
      postEl.setAttribute(PROCESSED_ATTR, "collapsed");
    }
  }

  // ─── Re-evaluate all (threshold changed) ──────────────────────────────
  let reEvalTimer = null;

  function reEvaluateAll() {
    clearTimeout(reEvalTimer);
    reEvalTimer = setTimeout(() => {
      if (!isFeedPage()) return;
      document.querySelectorAll(".ai-detector-badge").forEach((b) => b.remove());
      document.querySelectorAll(".ai-detector-section-hidden").forEach((el) => {
        el.classList.remove("ai-detector-section-hidden");
      });
      document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
        el.removeAttribute(PROCESSED_ATTR);
      });
      scanAndApply();
    }, 2000);
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

  // ─── Tooltip (appended to body, never clipped by overflow) ────────────

  let tooltipEl = null;

  function showTooltip(anchor, text) {
    if (!tooltipEl) {
      tooltipEl = document.createElement("div");
      tooltipEl.className = "ai-detector-tooltip";
      document.body.appendChild(tooltipEl);
    }
    tooltipEl.textContent = text;
    const r = anchor.getBoundingClientRect();
    tooltipEl.style.top = (r.top - 8) + "px";
    tooltipEl.style.left = r.left + "px";
    requestAnimationFrame(() => {
      const tt = tooltipEl.getBoundingClientRect();
      tooltipEl.style.top = (r.top - tt.height - 8) + "px";
      if (tt.right > window.innerWidth - 8) {
        tooltipEl.style.left = (window.innerWidth - tt.width - 8) + "px";
      }
      tooltipEl.classList.add("visible");
    });
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.classList.remove("visible");
  }

  // ─── Extension connection & context recovery ──────────────────────────

  let observer = null;
  let scanDebounce = null;
  let connected = false;
  let reconnectTimer = null;

  function connectMessaging() {
    if (connected) return;
    connected = true;

    chrome.storage.local.get(["aiDetectorThreshold"], (res) => {
      if (!contextValid()) return;
      threshold = res.aiDetectorThreshold ?? 70;
    });

    chrome.storage.onChanged.addListener((changes) => {
      if (!contextValid()) { startContextRecovery(); return; }
      if (changes.aiDetectorThreshold) {
        threshold = changes.aiDetectorThreshold.newValue ?? 70;
        reEvaluateAll();
      }
    });

    try {
      chrome.runtime.sendMessage({ type: "GET_ALL_SCORES" }, (res) => {
        if (chrome.runtime.lastError) {
          console.warn("[AI Detector] GET_ALL_SCORES error:", chrome.runtime.lastError.message);
          return;
        }
        if (res?.scores) {
          scores = res.scores;
          console.log("[AI Detector] Loaded", Object.keys(res.scores).length, "cached scores");
          scanAndApply();
        }
      });
    } catch (e) {
      console.warn("[AI Detector] sendMessage error:", e);
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (!contextValid()) { startContextRecovery(); return; }

      if (msg.type === "SCORE_READY") {
        scores[msg.postKey] = { score: msg.score, reason: msg.reason };
        applyScoreToPost(msg.postKey);
      }

      if (msg.type === "NEED_API_KEY" && !apiKeyNotified) {
        apiKeyNotified = true;
        showApiKeyNotification();
      }
    });

    console.log("[AI Detector] v2.5 — dismiss-pair primary anchor. Running initial scan...");
    scanAndApply();
  }

  function startContextRecovery() {
    if (reconnectTimer) return;
    connected = false;
    console.log("[AI Detector] Extension context lost — starting recovery...");

    let attempts = 0;
    reconnectTimer = setInterval(() => {
      attempts++;
      if (contextValid()) {
        console.log(`[AI Detector] Context recovered after ${attempts}s, reconnecting...`);
        clearInterval(reconnectTimer);
        reconnectTimer = null;
        connectMessaging();
      }
    }, 1000);
  }

  // ─── MutationObserver ──────────────────────────────────────────────────

  function boot() {
    if (contextValid()) {
      try { scanAndApply(); }
      catch (e) { console.warn("[AI Detector] scanAndApply error:", e); }
    }

    if (observer) return;

    try {
      observer = new MutationObserver(() => {
        if (!contextValid()) { startContextRecovery(); return; }
        clearTimeout(scanDebounce);
        scanDebounce = setTimeout(() => {
          try { scanAndApply(); }
          catch (e) { console.warn("[AI Detector] scanAndApply error:", e); }
        }, 500);
      });

      observer.observe(document.body, { childList: true, subtree: true });
    } catch (e) {
      console.warn("[AI Detector] Observer setup error:", e);
      observer = null;
    }
  }

  // ─── Init ──────────────────────────────────────────────────────────────

  if (contextValid()) {
    connectMessaging();
  } else {
    startContextRecovery();
  }
  boot();

  // ─── SPA navigation handler ──────────────────────────────────────────
  let lastPath = location.pathname;
  setInterval(() => {
    if (!contextValid()) { startContextRecovery(); return; }
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      zeroResultCount = 0;
      diagnosticNotified = false;
      if (isFeedPage()) boot();
    }
  }, 2000);

})();
