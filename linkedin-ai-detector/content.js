// LinkedIn AI Post Detector v2.4 — Content Script
// Anchor-first approach: two anchors drive everything.
//   1. "… more" button text → post text is in the parent, send to API
//   2. ⋯ + ✕ dismiss button pair → crawl UP from "… more" to the first
//      ancestor containing this pair. That's the post boundary.
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

  // ─── Find all "… more" buttons by visible text ────────────────────────
  function findMoreButtons() {
    const results = [];
    for (const btn of document.querySelectorAll("button")) {
      if (btn.textContent.trim() === MORE_TEXT) results.push(btn);
    }
    return results;
  }

  // ─── Anchor 2: find the ⋯ + ✕ dismiss pair inside an element ─────────
  // Two consecutive sibling buttons, both SVG-only (no text), visible,
  // near the top of the element. Returns the pair or null.

  function findDismissPair(el) {
    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0) return null; // invisible element, skip

    const btns = el.querySelectorAll("button");
    for (const btn of btns) {
      if (!btn.querySelector("svg")) continue;
      if (btn.textContent.trim().length > 0) continue;
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.top > elRect.top + 120) continue;

      // Check if next sibling is also an SVG-only button
      const next = btn.nextElementSibling;
      if (!next || next.tagName !== "BUTTON") continue;
      if (!next.querySelector("svg")) continue;
      if (next.textContent.trim().length > 0) continue;
      if (next.getBoundingClientRect().width === 0) continue;

      return { dotsBtn: btn, dismissBtn: next, controlRow: btn.parentElement };
    }
    return null;
  }

  // ─── Walk from "… more" UP to post boundary ───────────────────────────
  // The post boundary is the smallest ancestor of the "… more" button
  // that also contains the ⋯ + ✕ dismiss pair. This works for any
  // nesting depth — regular posts and reposts alike.
  //
  // For reposts: the inner "… more" still walks up to the outer post's
  // ⋯ + ✕ pair, landing on the same boundary as the outer "… more".
  // The dedup Set in findPosts() handles this.

  function getPostBoundary(moreBtn) {
    let node = moreBtn.parentElement;
    while (node && node !== document.body) {
      if (findDismissPair(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  // ─── Get post text from the button's parent (the text container) ──────
  function getPostText(btn) {
    const textContainer = btn.parentElement;
    if (!textContainer) return "";
    const clone = textContainer.cloneNode(true);
    for (const b of clone.querySelectorAll("button")) b.remove();
    return clone.innerText.trim();
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
    // Primary: profile link anchor
    const profileLinks = boundary.querySelectorAll('a[href*="/in/"]');
    for (const pl of profileLinks) {
      const name = pl.innerText.trim().split("\n")[0].trim();
      if (name && name.length > 2 && name.length < 60) return name;
    }
    // Fallback: first link next to an image (avatar) with readable name text
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
  function findPosts() {
    const buttons = findMoreButtons();
    if (buttons.length === 0) return [];

    const seen = new Set();  // deduplicate: reposts have 2 buttons → same boundary
    const results = [];

    for (const btn of buttons) {
      const boundary = getPostBoundary(btn);
      if (!boundary) continue;
      if (seen.has(boundary)) continue;
      seen.add(boundary);

      if (boundary.getAttribute(PROCESSED_ATTR)) continue;

      const text = getPostText(btn);
      if (text.length < 20) continue;

      const postKey = getPostKey(boundary, text);
      const author = getAuthor(boundary);

      results.push({ boundary, postKey, text, author });
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
    // If we're on a feed page with scrollable content but finding zero
    // posts across multiple scans, LinkedIn may have changed their DOM.
    if (posts.length === 0 && !diagnosticNotified) {
      // Only count if there's actually content on the page (not empty feed)
      const hasContent = document.body.scrollHeight > window.innerHeight * 1.5;
      const hasButtons = document.querySelectorAll("button").length > 10;
      if (hasContent && hasButtons) {
        zeroResultCount++;
        if (zeroResultCount >= 3) {
          diagnosticNotified = true;
          console.warn(
            "[AI Detector] Diagnostic: 0 posts detected after",
            zeroResultCount,
            "scans on a page with content.",
            "LinkedIn may have changed their DOM structure.",
            "\n  - '… more' buttons found:", findMoreButtons().length,
            "\n  - Buttons with dismiss pairs:", (() => {
              let count = 0;
              for (const btn of findMoreButtons()) {
                if (getPostBoundary(btn)) count++;
              }
              return count;
            })()
          );
        }
      }
    } else if (posts.length > 0) {
      zeroResultCount = 0; // reset on success
    }

    for (const { boundary, postKey, text, author } of posts) {
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

    const buttons = findMoreButtons();
    const seen = new Set();

    for (const btn of buttons) {
      const boundary = getPostBoundary(btn);
      if (!boundary || seen.has(boundary)) continue;
      seen.add(boundary);

      const text = getPostText(btn);
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
  // Anchor 2 drives collapsing:
  //   - The ⋯ + ✕ pair's controlRow = header area → keep visible
  //   - Walk UP from controlRow to find the container holding both header
  //     and actions bar (two functional anchors, no child-count assumption)
  //   - Everything between header and action bar = content → hide

  // ─── Inject badge on every scored post ──────────────────────────────
  function injectBadge(postEl, postKey, scoreData) {
    // Don't inject twice
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
      `<span class="ai-detector-score ${scoreClass}">\uD83E\uDD16 ${score}%</span>` +
      `<button class="ai-detector-toggle" aria-label="Toggle AI-flagged post" style="display:none">\u25BC</button>`;

    badge.addEventListener("mousedown", (e) => e.stopPropagation(), true);
    badge.querySelector(".ai-detector-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      togglePost(postEl);
    }, true);

    // Tooltip on hover
    const scoreSpan = badge.querySelector(".ai-detector-score");
    scoreSpan.addEventListener("mouseenter", () => showTooltip(scoreSpan, reason));
    scoreSpan.addEventListener("mouseleave", hideTooltip);

    pair.controlRow.insertBefore(badge, pair.dotsBtn);
  }

  // ─── Identify the author section (anchor: profile link with name) ────
  // The author row is the content section containing a profile link
  // (a[href*="/in/"]) with visible name text. Anchor-first: no tags,
  // no classes — just the link pattern and human-readable text.

  function isAuthorSection(section) {
    // Primary: profile link with visible name text
    const profileLinks = section.querySelectorAll('a[href*="/in/"]');
    for (const a of profileLinks) {
      const name = a.innerText.trim().split("\n")[0].trim();
      if (name.length > 2 && name.length < 80) return true;
    }
    // Fallback: a section containing both a link and an image (avatar pattern)
    // Covers the case where LinkedIn changes profile URL format away from /in/
    if (section.querySelector("a") && section.querySelector("img")) {
      const links = section.querySelectorAll("a");
      for (const a of links) {
        const name = a.innerText.trim().split("\n")[0].trim();
        if (name.length > 2 && name.length < 80) return true;
      }
    }
    return false;
  }

  // ─── Collapse post (only when above threshold) ────────────────────────
  function collapsePost(postEl, postKey) {
    if (postEl.getAttribute(PROCESSED_ATTR) === "collapsed") return;

    // Show the toggle arrow on collapsed posts
    const toggle = postEl.querySelector(".ai-detector-toggle");
    if (toggle) toggle.style.display = "";

    const pair = findDismissPair(postEl);
    if (!pair) return;

    const { content, actions } = getContentSections(postEl, pair);
    for (const section of content) {
      // Anchor: keep the author row visible — it's the section containing
      // a profile link (a[href*="/in/"]) with visible name text.
      if (isAuthorSection(section)) continue;
      section.classList.add("ai-detector-section-hidden");
    }
    for (const section of actions) {
      section.classList.add("ai-detector-section-hidden");
    }

    postEl.setAttribute(PROCESSED_ATTR, "collapsed");
  }

  // ─── Find the actions bar anchor (Like/Comment/Repost/Send) ────────
  // Looks for a descendant container with 3+ buttons that are likely
  // the social actions row. Returns the direct child of `container`
  // that contains it, or null.

  function findActionsChild(container, afterIdx) {
    const sections = Array.from(container.children);
    // Walk from the bottom up — actions bar is always near the end
    for (let i = sections.length - 1; i > afterIdx; i--) {
      const btns = sections[i].querySelectorAll("button");
      if (btns.length >= 3) return i;
    }
    return sections.length; // fallback: no actions bar found
  }

  function getContentSections(postEl, pair) {
    // Adaptive approach: walk UP from controlRow to find a container
    // that holds BOTH the header (controlRow ancestor) and the actions
    // bar (3+ buttons section). No fixed child-count threshold.
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

      // Check if this parent also contains an actions bar below headerChild
      const actionsIdx = findActionsChild(parent, idx);
      if (actionsIdx < siblings.length) {
        // Found a container with both anchors — use it
        container = parent;
        headerIdx = idx;
        break;
      }

      // Fallback: if parent has 4+ children, it's likely the layout container
      // even if actions bar detection failed (e.g. LinkedIn changed the bar)
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
  // 2-second debounce: gives the user time to settle on a value
  // (especially when dragging the slider) before doing DOM work.
  // No LLM calls happen here — just re-applies cached scores.

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
    tooltipEl.style.top = (r.top - 8) + "px";   // position above anchor
    tooltipEl.style.left = r.left + "px";
    // Nudge into view after rendering
    requestAnimationFrame(() => {
      const tt = tooltipEl.getBoundingClientRect();
      // Place above the badge
      tooltipEl.style.top = (r.top - tt.height - 8) + "px";
      // Keep within viewport horizontally
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

    console.log("[AI Detector] Messaging connected, running initial scan...");
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
