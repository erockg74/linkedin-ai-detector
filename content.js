// LinkedIn AI Post Detector v2.9 — Content Script
// Anchor-first approach with two page modes:
//
// FEED pages (/, /feed, /search/*, /posts/*):
//   1. ⋯ + ✕ dismiss pair → PRIMARY anchor. Exists on EVERY feed post.
//      Walk UP from the pair until the parent contains other pairs.
//   2. "… more" button → SECONDARY anchor for clean text extraction.
//
// ACTIVITY pages (/in/*/recent-activity/*):
//   1. data-urn elements → each div[data-urn*="activity"] IS the post card.
//      No boundary walking needed (1:1 mapping by definition).
//   2. Control menu button (⋯ only, no ✕) → anchor for badge placement.
//      A "virtual pair" is synthesized so badge injection code is shared.
//   3. "… more" button → same secondary anchor for text extraction.

(function () {
  "use strict";

  // ─── Re-injection guard ──────────────────────────────────────────────
  // The background script may re-inject content.js after SPA navigation
  // when the previous instance's context has died. Only skip if an
  // existing instance is still alive (has a valid chrome.runtime context).
  if (window.__aiDetectorLoaded) {
    try {
      if (chrome.runtime?.id) return; // existing instance is healthy
    } catch (e) { /* context dead — fall through to re-initialize */ }
  }
  window.__aiDetectorLoaded = true;

  // ─── Page-type guards ────────────────────────────────────────────────
  function isFeedPage() {
    const path = location.pathname;
    return path === "/" || path === "/feed/" || path === "/feed"
      || path.startsWith("/search/") || path.startsWith("/posts/");
  }

  function isActivityPage() {
    return /^\/in\/[^/]+\/recent-activity\b/.test(location.pathname);
  }

  function isSupportedPage() {
    return isFeedPage() || isActivityPage();
  }

  // ─── State ─────────────────────────────────────────────────────────────
  const PROCESSED_ATTR = "data-ai-detector-v2";
  const MORE_TEXT = "\u2026 more";    // "… more" — feed variant
  const MORE_TEXT_ALT = "\u2026more"; // "…more"  — activity page variant
  let threshold = 70;
  let scores = {};           // postKey → { score, reason }
  let apiKeyNotified = false;
  let zeroResultCount = 0;        // consecutive scans with zero posts found
  let diagnosticNotified = false;  // only warn once per page load
  let debugHighlight = false;      // toggle: highlight extracted text

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

  // ─── PRIMARY ANCHOR: find ALL post control-menu buttons on the page ───
  // Strategy:
  //   1. ⋯ + ✕ dismiss pair — two adjacent SVG-only buttons (regular posts).
  //   2. Lone "Open control menu" button — for promoted/sponsored posts
  //      that have ⋯ but no ✕ dismiss button. Uses the stable aria-label
  //      attribute: "Open control menu for post by ...".
  // Returns an array of { dotsBtn, dismissBtn, controlRow }.

  function findAllDismissPairs() {
    const pairs = [];
    const pairedBtns = new Set();

    // Pass 1: find ⋯ + ✕ pairs (highest confidence)
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
      pairedBtns.add(btn);
      pairedBtns.add(next);
    }

    // Pass 2: find lone "Open control menu" buttons not already in a pair.
    // These appear on promoted/sponsored posts that lack a ✕ dismiss button.
    // The aria-label is a stable accessibility attribute.
    for (const btn of document.querySelectorAll('button[aria-label^="Open control menu"]')) {
      if (pairedBtns.has(btn)) continue;
      if (btn.getBoundingClientRect().width === 0) continue;

      // Synthesize a pair-like object (no dismiss button)
      pairs.push({ dotsBtn: btn, dismissBtn: null, controlRow: btn.parentElement });
    }

    return pairs;
  }

  // ─── Find the ⋯ + ✕ dismiss pair inside a known post boundary ────────
  // Used by injectBadge, collapsePost, etc. when we already have the card.
  // Falls back to a lone "Open control menu" button for promoted posts.
  function findDismissPair(el) {
    const elRect = el.getBoundingClientRect();
    if (elRect.width === 0) return null;

    // Try ⋯ + ✕ pair first
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

    // Fallback: lone "Open control menu" button (promoted/sponsored posts)
    const menuBtn = el.querySelector('button[aria-label^="Open control menu"]');
    if (menuBtn && menuBtn.getBoundingClientRect().width > 0) {
      return { dotsBtn: menuBtn, dismissBtn: null, controlRow: menuBtn.parentElement };
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

  // ─── ACTIVITY PAGE: synthesise a virtual pair from the control menu ───
  // On activity pages the ⋯ + ✕ dismiss pair doesn't exist. Instead each
  // post has a single "Open control menu" button inside a dropdown.
  // We build a pair-like object so injectBadge / extractPostText reuse
  // the same code paths as the feed.
  //
  // Structure on activity page:
  //   div.relative
  //     div.display-flex (author info)
  //     div.feed-shared-control-menu        ← controlRow (badge goes here)
  //       div.artdeco-dropdown              ← dotsBtn (badge inserted before this)
  //         button[aria-label*="Open control menu"]
  //
  // This mirrors the feed layout where the badge sits inside the control
  // row, immediately before the ⋯ button element.

  function findActivityVirtualPair(postEl) {
    const menuContainer = postEl.querySelector(".feed-shared-control-menu");
    if (!menuContainer) return null;

    const dropdown = menuContainer.querySelector(".artdeco-dropdown");
    if (!dropdown) return null;

    const triggerBtn = dropdown.querySelector(
      'button[aria-label*="Open control menu"]'
    );

    return {
      dotsBtn: dropdown,        // badge is inserted before this element
      dismissBtn: null,         // doesn't exist on activity pages
      controlRow: menuContainer, // the container holding the dropdown
      _activityTrigger: triggerBtn  // the actual ⋯ button (for future use)
    };
  }

  // ─── ACTIVITY PAGE: find all unprocessed posts ─────────────────────
  function findActivityPosts() {
    const postEls = document.querySelectorAll('[data-urn*="urn:li:activity"]');
    const results = [];

    for (const postEl of postEls) {
      const existingState = postEl.getAttribute(PROCESSED_ATTR);
      if (existingState && existingState !== "unscored") {
        if (existingState === "pending") {
          const sentAt = parseInt(postEl.getAttribute("data-ai-pending-ts") || "0", 10);
          if (Date.now() - sentAt < 5000) continue;
        } else {
          continue;
        }
      }

      const pair = findActivityVirtualPair(postEl);
      if (!pair) continue;

      const text = extractPostText(postEl, pair);
      if (text.length < 20) {
        if (!existingState) {
          injectUnscoredBadge(postEl, pair);
          postEl.setAttribute(PROCESSED_ATTR, "unscored");
        }
        continue;
      }

      // If previously unscored but now has text, remove old badge
      if (existingState === "unscored") {
        const oldBadge = postEl.querySelector(".ai-detector-badge");
        if (oldBadge) oldBadge.remove();
      }

      // URN comes directly from the data-urn attribute
      const urn = postEl.getAttribute("data-urn");
      const postKey = urn || hashText(text);
      const author = getAuthor(postEl);

      results.push({ boundary: postEl, pair, postKey, text, author });
    }

    return results;
  }

  // ─── SECONDARY ANCHOR: find "… more" button inside a post card ────────
  // When present, its parent element contains the clean post text.
  function findMoreButton(card) {
    for (const btn of card.querySelectorAll("button")) {
      const t = btn.textContent.trim();
      if (t === MORE_TEXT || t === MORE_TEXT_ALT) return btn;
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
    // Primary: /in/ profile links
    const profileLinks = section.querySelectorAll('a[href*="/in/"]');
    for (const a of profileLinks) {
      const name = a.innerText.trim().split("\n")[0].trim();
      if (name.length > 2 && name.length < 80) return true;
    }
    // Fallback: /company/ page links with image (company author headers)
    const companyLinks = section.querySelectorAll('a[href*="/company/"]');
    if (companyLinks.length > 0 && section.querySelector("img")) {
      for (const a of companyLinks) {
        const name = a.innerText.trim().split("\n")[0].trim();
        if (name.length > 2 && name.length < 80) return true;
      }
    }
    return false;
  }

  // ─── Nested post detection ──────────────────────────────────────────
  // When someone "likes this", "commented on this", "celebrates this",
  // etc., LinkedIn wraps the original post inside the outer card.
  // Structure (at depth ~2 inside the boundary):
  //   [0] H2  "Feed post"
  //   [1] DIV "Person X likes/commented/celebrates this" + ⋯/✕ buttons
  //   [2] HR  role="presentation"     ← separator
  //   [3] DIV inner author (person or company)
  //   [4] P   inner post text (with optional "… more")
  //   ...
  // We detect this by finding <hr role="presentation"> whose previous
  // sibling contains social-context text. When found, we return the
  // parent element scoped to just the children AFTER the HR — i.e., the
  // inner post only. This is a semantic HTML element that LinkedIn uses
  // for accessibility and is unlikely to change.

  const SOCIAL_CONTEXT_RE = /\b(likes? this|commented on this|celebrates? this|reposted|loves? this|finds? this|supports? this|is curious about this)\b/i;

  /**
   * For a nested/reshared post, returns a "virtual card" element that
   * contains only the inner post content (after the HR separator).
   * Returns null if this is a regular (non-nested) post.
   */
  function findInnerPostScope(card) {
    // Walk down through single-child wrappers to reach the structural split
    let el = card;
    let depth = 0;
    while (depth < 5) {
      // Look for HR separators at this level
      const children = Array.from(el.children);
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.tagName !== "HR") continue;
        if (child.getAttribute("role") !== "presentation") continue;

        // Check if preceding sibling contains social context text
        const prev = children[i - 1];
        if (!prev) continue;
        const prevText = prev.innerText || "";
        if (!SOCIAL_CONTEXT_RE.test(prevText)) continue;

        // Found it! The inner post starts after this HR.
        // Build a lightweight container holding only the inner post children
        // (from HR+1 up to the next HR or actions bar).
        const innerChildren = [];
        for (let j = i + 1; j < children.length; j++) {
          const sib = children[j];
          // Stop at the second HR (engagement/actions separator)
          if (sib.tagName === "HR") break;
          innerChildren.push(sib);
        }

        if (innerChildren.length === 0) return null;

        // Return the parent element + the range, so callers can scope
        // their queries to just the inner post elements.
        return { container: el, startIdx: i + 1, innerChildren };
      }

      // No HR at this level — drill down if there's a single wrapper child
      if (el.children.length <= 2) {
        const first = el.firstElementChild;
        if (first && first.tagName === "DIV" && first.getBoundingClientRect().height > 50) {
          el = first;
          depth++;
          continue;
        }
      }
      break;
    }
    return null;
  }

  /**
   * If the card is a nested post, creates a temporary DOM fragment
   * containing only the inner post's elements for text extraction.
   * Falls through to null for regular posts.
   */
  function getInnerPostCard(card) {
    const scope = findInnerPostScope(card);
    if (!scope) return null;

    // Build a detached container so querySelectorAll and innerText work
    const frag = document.createElement("div");
    for (const child of scope.innerChildren) {
      frag.appendChild(child.cloneNode(true));
    }
    return { fragment: frag, liveChildren: scope.innerChildren };
  }

  // ─── Text extraction ─────────────────────────────────────────────────
  // Strategy: if "… more" exists, use its parent for clean text (proven).
  // Otherwise, pull text from content sections, skipping author,
  // engagement stats, inline comments, and empty sections.
  //
  // For nested posts ("X likes/commented/celebrates this"), we first
  // narrow the scope to just the inner post using HR separators.

  function extractPostText(card, pair) {
    // For nested posts, narrow scope to the inner post only
    const inner = getInnerPostCard(card);
    if (inner) {
      // Try "… more" inside the inner post fragment
      const innerMoreBtn = findMoreButton(inner.fragment);
      if (innerMoreBtn) {
        const textContainer = innerMoreBtn.parentElement;
        if (textContainer) {
          const clone = textContainer.cloneNode(true);
          for (const b of clone.querySelectorAll("button")) b.remove();
          const text = clone.innerText.trim();
          if (text.length >= 20) return text;
        }
      }

      // Fall back to innerText of the fragment, filtering noise
      const fullText = inner.fragment.innerText || "";
      const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);
      const noise = /^(Like|Comment|Repost|Send|Reply|Report|Follow|Connect|\d+ reactions?|\d+ comments?|\d+ reposts?|\d+$|Edited|Promoted|Suggested|\u2026\s?more)$/i;
      const cleaned = [];
      let pastAuthor = false;
      for (const line of lines) {
        if (!pastAuthor) {
          if (/^\d+[smhd]\s*\u00B7?$/.test(line) || /^(\d+(st|nd|rd)|\d+\+)$/.test(line)) {
            pastAuthor = true;
            continue;
          }
          if (cleaned.length === 0 && line.length < 60 && !line.includes(".")) continue;
        }
        if (noise.test(line)) continue;
        cleaned.push(line);
      }
      const innerText = cleaned.join("\n").trim();
      if (innerText.length >= 20) return innerText;
    }
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

    // Fallback 1: extract from content sections
    const sections = getContentSections(card, pair);
    if (sections) {
      let text = "";
      for (const section of sections.content) {
        if (isAuthorSection(section)) continue;
        if (isEngagementSection(section)) continue;
        if (isInlineComment(section)) continue;
        const sectionText = section.innerText.trim();
        if (sectionText.length === 0) continue;
        text += sectionText + "\n";
      }
      if (text.trim().length >= 20) return text.trim();
    }

    // Fallback 2: direct text extraction from post boundary.
    // LinkedIn sometimes uses fully obfuscated class names, so structured
    // extraction can fail. Grab the full innerText and strip known noise
    // (author info, engagement stats, action bar text).
    const fullText = card.innerText || "";
    // Split into lines and filter out noise
    const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);
    const noise = /^(Like|Comment|Repost|Send|Reply|Report|Follow|Connect|\d+ reactions?|\d+ comments?|\d+ reposts?|\d+$|Edited|Promoted|Suggested|\u2026\s?more)$/i;
    const cleaned = [];
    let pastAuthor = false;
    for (const line of lines) {
      // Skip author block lines (name, title, connection degree, time)
      if (!pastAuthor) {
        if (/^\d+[smhd]\s*\u00B7?$/.test(line) || /^(\d+(st|nd|rd)|\d+\+)$/.test(line)) {
          pastAuthor = true;
          continue;
        }
        // Short lines near the top are likely author/title info
        if (cleaned.length === 0 && line.length < 60 && !line.includes(".")) continue;
      }
      if (noise.test(line)) continue;
      cleaned.push(line);
    }
    return cleaned.join("\n").trim();
  }

  // ─── Debug: highlight the DOM elements that extractPostText reads ──────
  const HIGHLIGHT_CLASS = "ai-detector-debug-highlight";

  function highlightExtractedText(card, pair) {
    // Path 0: nested post → highlight just the inner post content
    const scope = findInnerPostScope(card);
    if (scope) {
      // Highlight the inner post elements (skip author, just content)
      for (let i = 1; i < scope.innerChildren.length; i++) {
        const child = scope.innerChildren[i];
        if (child.innerText.trim().length > 0) {
          child.classList.add(HIGHLIGHT_CLASS);
          return;
        }
      }
    }

    // Path 1: "… more" button → highlight its parent container
    const moreBtn = findMoreButton(card);
    if (moreBtn) {
      const textContainer = moreBtn.parentElement;
      if (textContainer) {
        const clone = textContainer.cloneNode(true);
        for (const b of clone.querySelectorAll("button")) b.remove();
        if (clone.innerText.trim().length >= 20) {
          textContainer.classList.add(HIGHLIGHT_CLASS);
          return;
        }
      }
    }

    // Path 2: content sections → highlight the sections used
    const sections = getContentSections(card, pair);
    if (sections) {
      let found = false;
      for (const section of sections.content) {
        if (isAuthorSection(section)) continue;
        if (isEngagementSection(section)) continue;
        if (isInlineComment(section)) continue;
        if (section.innerText.trim().length === 0) continue;
        section.classList.add(HIGHLIGHT_CLASS);
        found = true;
      }
      if (found) return;
    }

    // Path 3: direct text fallback → highlight the entire card
    card.classList.add(HIGHLIGHT_CLASS);
  }

  function clearAllHighlights() {
    for (const el of document.querySelectorAll("." + HIGHLIGHT_CLASS)) {
      el.classList.remove(HIGHLIGHT_CLASS);
    }
  }

  function toggleDebugHighlights() {
    debugHighlight = !debugHighlight;
    if (!debugHighlight) {
      clearAllHighlights();
      return;
    }
    // Highlight extracted text in all processed posts
    const posts = document.querySelectorAll("[" + PROCESSED_ATTR + "]");
    for (const post of posts) {
      const pair = findDismissPair(post) || findActivityVirtualPair(post);
      highlightExtractedText(post, pair);
    }
  }

  // Alt+click on any badge toggles debug highlights
  document.addEventListener("click", (e) => {
    if (!e.altKey) return;
    const badge = e.target.closest(".ai-detector-badge");
    if (!badge) return;
    e.preventDefault();
    e.stopPropagation();
    toggleDebugHighlights();
  }, true);

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
  // For nested posts, returns the inner post's author (person or company).
  function getAuthor(boundary) {
    // For nested posts, get the inner post author from the first element
    // after the HR separator (which is the author section of the original post).
    const scope = findInnerPostScope(boundary);
    if (scope && scope.innerChildren.length > 0) {
      const authorEl = scope.innerChildren[0]; // DIV right after HR
      // Check for person profile links
      const personLinks = authorEl.querySelectorAll('a[href*="/in/"]');
      for (const a of personLinks) {
        const name = a.innerText.trim().split("\n")[0].trim();
        if (name && name.length > 2 && name.length < 60) return name;
      }
      // Check for company page links
      const companyLinks = authorEl.querySelectorAll('a[href*="/company/"]');
      for (const a of companyLinks) {
        const name = a.innerText.trim().split("\n")[0].trim();
        if (name && name.length > 2 && name.length < 60) return name;
      }
    }

    // Regular post: first profile link in the boundary
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
  // Delegates to the correct discovery strategy based on page type.
  function findPosts() {
    if (isActivityPage()) return findActivityPosts();

    // Feed mode: primary anchor is ⋯ + ✕ dismiss pair.
    const allPairs = findAllDismissPairs();
    if (allPairs.length === 0) return [];

    const results = [];

    for (const pair of allPairs) {
      const boundary = findPostCard(pair, allPairs);
      if (!boundary) continue;
      const existingState = boundary.getAttribute(PROCESSED_ATTR);
      // Skip already-scored/collapsed/expanded posts, but re-check "unscored"
      // (content may have loaded late) and "pending" (message may have been
      // lost). Pending posts retry every 5 seconds.
      if (existingState && existingState !== "unscored") {
        if (existingState === "pending") {
          const sentAt = parseInt(boundary.getAttribute("data-ai-pending-ts") || "0", 10);
          if (Date.now() - sentAt < 5000) continue; // wait at least 5s before retry
        } else {
          continue;
        }
      }

      const text = extractPostText(boundary, pair);
      if (text.length < 20) {
        // Not enough text to score — inject dimmed "AI –" pill and mark done
        if (!existingState) {
          injectUnscoredBadge(boundary, pair);
          boundary.setAttribute(PROCESSED_ATTR, "unscored");
        }
        continue;
      }

      // If this was previously unscored but now has text, remove old badge
      if (existingState === "unscored") {
        const oldBadge = boundary.querySelector(".ai-detector-badge");
        if (oldBadge) oldBadge.remove();
      }

      const postKey = getPostKey(boundary, text);
      const author = getAuthor(boundary);

      results.push({ boundary, pair, postKey, text, author });
    }

    return results;
  }

  // ─── Scan and apply ───────────────────────────────────────────────────

  function scanAndApply() {
    if (!isSupportedPage()) return;
    if (!contextValid()) return;

    const posts = findPosts();
    const newPosts = [];

    // ─── Self-healing diagnostics ─────────────────────────────────────
    // Activity pages render data-urn elements asynchronously — give them
    // more time before warning (6 scans vs 3 for feed).
    const diagThreshold = isActivityPage() ? 6 : 3;
    if (posts.length === 0 && !diagnosticNotified) {
      const hasContent = document.body.scrollHeight > window.innerHeight * 1.5;
      const hasButtons = document.querySelectorAll("button").length > 10;
      if (hasContent && hasButtons) {
        zeroResultCount++;
        if (zeroResultCount >= diagThreshold) {
          diagnosticNotified = true;
          const onActivity = isActivityPage();
          const allPairs = onActivity ? [] : findAllDismissPairs();
          const urnCount = onActivity
            ? document.querySelectorAll('[data-urn*="urn:li:activity"]').length
            : 0;
          console.warn(
            "[AI Detector] Diagnostic: 0 posts detected after",
            zeroResultCount, "scans on a page with content.",
            "LinkedIn may have changed their DOM structure.",
            onActivity
              ? "\n  - Activity URN elements found: " + urnCount
              : "\n  - Dismiss pairs found: " + allPairs.length,
            onActivity ? "" : "\n  - Post cards resolved: " + (() => {
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

    const activity = isActivityPage();
    for (const { boundary, pair, postKey, text, author } of posts) {
      if (scores[postKey]) {
        injectBadge(boundary, postKey, scores[postKey]);
        if (!activity && scores[postKey].score >= threshold) {
          const didCollapse = collapsePost(boundary, postKey, pair);
          if (!didCollapse) {
            // DOM not ready yet — mark scored so next scan retries
            boundary.setAttribute(PROCESSED_ATTR, "scored");
          }
        } else {
          boundary.setAttribute(PROCESSED_ATTR, "scored");
        }
        continue;
      }

      newPosts.push({ postKey, text, author });
      // Show pulsing "AI …" pill while waiting for the score
      injectPendingBadge(boundary, pair);
      boundary.setAttribute(PROCESSED_ATTR, "pending");
      boundary.setAttribute("data-ai-pending-ts", String(Date.now()));
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

    // ─── Retry collapse for above-threshold posts stuck in "scored" state ──
    // This catches posts where collapsePost failed on first attempt
    // (DOM not ready, virtual recycling, etc.)
    if (!activity) {
      retryPendingCollapses();
    }
  }

  function retryPendingCollapses() {
    const scoredEls = document.querySelectorAll(`[${PROCESSED_ATTR}="scored"]`);
    for (const el of scoredEls) {
      const badge = el.querySelector(".ai-detector-badge");
      if (!badge) continue;
      const key = badge.getAttribute("data-ai-key");
      if (!key || !scores[key]) continue;
      if (scores[key].score < threshold) continue;
      // This post is above threshold but not collapsed — retry
      collapsePost(el, key);
    }
  }

  // ─── Apply a single score (callback from background) ──────────────────

  function applyScoreToPost(postKey) {
    if (!isSupportedPage()) return;
    const scoreData = scores[postKey];
    if (!scoreData) return;

    if (isActivityPage()) {
      // Activity page: find post by data-urn or text hash
      const postEls = document.querySelectorAll('[data-urn*="urn:li:activity"]');
      for (const postEl of postEls) {
        const urn = postEl.getAttribute("data-urn");
        const pair = findActivityVirtualPair(postEl);
        if (!pair) continue;

        const text = extractPostText(postEl, pair);
        const thisKey = urn || hashText(text);

        if (thisKey === postKey) {
          injectBadge(postEl, postKey, scoreData);
          postEl.setAttribute(PROCESSED_ATTR, "scored");
        }
      }
      return;
    }

    // Feed mode
    const allPairs = findAllDismissPairs();

    for (const pair of allPairs) {
      const boundary = findPostCard(pair, allPairs);
      if (!boundary) continue;

      const text = extractPostText(boundary, pair);
      const thisKey = getPostKey(boundary, text);

      if (thisKey === postKey) {
        injectBadge(boundary, postKey, scoreData);
        if (scoreData.score >= threshold) {
          const didCollapse = collapsePost(boundary, postKey, pair);
          if (!didCollapse) {
            // DOM wasn't ready — retry after a frame + short delay
            boundary.setAttribute(PROCESSED_ATTR, "scored");
            requestAnimationFrame(() => {
              setTimeout(() => {
                if (boundary.getAttribute(PROCESSED_ATTR) !== "collapsed") {
                  collapsePost(boundary, postKey);
                }
              }, 150);
            });
          }
        } else {
          boundary.setAttribute(PROCESSED_ATTR, "scored");
        }
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
  function injectPendingBadge(postEl, pair) {
    if (postEl.querySelector(".ai-detector-badge")) return;
    if (!pair) { pair = findDismissPair(postEl) || findActivityVirtualPair(postEl); }
    if (!pair) return;

    const badge = document.createElement("div");
    badge.className = "ai-detector-badge";
    badge.innerHTML =
      `<span class="ai-detector-score ai-detector-score-pending">` +
        `<span class="ai-detector-ai-label">AI</span>` +
        `<span class="ai-detector-spinner"></span>` +
        `<button class="ai-detector-toggle" style="visibility:hidden" aria-hidden="true">\u25BC</button>` +
      `</span>`;

    const scoreSpan = badge.querySelector(".ai-detector-score");
    scoreSpan.addEventListener("mouseenter", () => showTooltip(scoreSpan, "Scoring\u2026"));
    scoreSpan.addEventListener("mouseleave", hideTooltip);

    pair.controlRow.insertBefore(badge, pair.dotsBtn);
  }

  function injectUnscoredBadge(postEl, pair, tooltipText) {
    if (postEl.querySelector(".ai-detector-badge")) return;
    if (!pair) { pair = findDismissPair(postEl) || findActivityVirtualPair(postEl); }
    if (!pair) return;

    const badge = document.createElement("div");
    badge.className = "ai-detector-badge";
    badge.innerHTML =
      `<span class="ai-detector-score ai-detector-score-unscored">` +
        `<span class="ai-detector-ai-label">AI</span>\u2013` +
        `<button class="ai-detector-toggle" style="visibility:hidden" aria-hidden="true">\u25BC</button>` +
      `</span>`;

    const tip = tooltipText || "Not enough text to assess";
    const scoreSpan = badge.querySelector(".ai-detector-score");
    scoreSpan.addEventListener("mouseenter", () => showTooltip(scoreSpan, tip));
    scoreSpan.addEventListener("mouseleave", hideTooltip);

    pair.controlRow.insertBefore(badge, pair.dotsBtn);
  }

  function injectBadge(postEl, postKey, scoreData) {
    // Remove any existing pending badge so the real score replaces it
    const existingBadge = postEl.querySelector(".ai-detector-badge");
    if (existingBadge) {
      if (existingBadge.querySelector(".ai-detector-score-pending")) {
        existingBadge.remove();
      } else {
        return; // already has a real badge
      }
    }

    const pair = findDismissPair(postEl) || findActivityVirtualPair(postEl);
    if (!pair) return;

    const score = scoreData.score;
    const reason = scoreData.reason;
    const tldr = scoreData.tldr || "";

    // score === -1 means Haiku determined this isn't a real post → grey pill
    if (score === -1) {
      injectUnscoredBadge(postEl, pair, reason || "Not a post");
      return;
    }

    const scoreClass = score >= 90 ? "ai-detector-score-high" :
                       score >= 70 ? "ai-detector-score-mid" :
                       "ai-detector-score-low";

    const badge = document.createElement("div");
    badge.className = "ai-detector-badge";
    badge.setAttribute("data-ai-key", postKey);
    const onActivity = isActivityPage();
    badge.innerHTML =
      `<span class="ai-detector-score ${scoreClass}">` +
        `<span class="ai-detector-ai-label">AI</span>${score}%` +
        `<button class="ai-detector-toggle" aria-label="Toggle AI-flagged post" style="visibility:hidden">\u25BC</button>` +
      `</span>`;

    badge.addEventListener("mousedown", (e) => e.stopPropagation(), true);
    badge.querySelector(".ai-detector-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (!onActivity) togglePost(postEl);
    }, true);

    // Build tooltip: reason always shown; TL;DR added for non-collapsed posts
    const willCollapse = score >= threshold;
    let tooltipContent = reason;
    if (!willCollapse && tldr) {
      tooltipContent = reason + "\n\nTL;DR: " + tldr;
    }

    const scoreSpan = badge.querySelector(".ai-detector-score");
    scoreSpan.addEventListener("mouseenter", () => showTooltip(scoreSpan, tooltipContent));
    scoreSpan.addEventListener("mouseleave", hideTooltip);

    pair.controlRow.insertBefore(badge, pair.dotsBtn);
  }

  // ─── Collapse post (only when above threshold) ────────────────────────
  // Returns true if content was actually hidden, false otherwise.
  // Accepts an optional pair to avoid re-querying the DOM (race-safe).
  function collapsePost(postEl, postKey, existingPair) {
    if (postEl.getAttribute(PROCESSED_ATTR) === "collapsed") return true;

    const pair = existingPair || findDismissPair(postEl) || findActivityVirtualPair(postEl);
    if (!pair) return false;

    const { content, actions } = getContentSections(postEl, pair);

    // Count how many non-author sections we'll actually hide
    let hiddenCount = 0;
    for (const section of content) {
      if (isAuthorSection(section)) continue;
      section.classList.add("ai-detector-section-hidden");
      hiddenCount++;
    }
    for (const section of actions) {
      section.classList.add("ai-detector-section-hidden");
      hiddenCount++;
    }

    if (hiddenCount === 0) return false;

    // Only show toggle and mark collapsed when we actually hid something
    const toggle = postEl.querySelector(".ai-detector-toggle");
    if (toggle) toggle.style.visibility = "visible";
    postEl.setAttribute(PROCESSED_ATTR, "collapsed");
    return true;
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
    if (!pair) pair = findDismissPair(postEl) || findActivityVirtualPair(postEl);
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
      if (!isSupportedPage()) return;
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
    // Support line breaks for TL;DR display
    if (text.includes("\n")) {
      tooltipEl.innerHTML = "";
      const parts = text.split("\n\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) tooltipEl.appendChild(document.createElement("br"));
        const span = document.createElement("span");
        if (parts[i].startsWith("TL;DR:")) {
          span.style.cssText = "display:block;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.2);";
        }
        span.textContent = parts[i];
        tooltipEl.appendChild(span);
      }
    } else {
      tooltipEl.textContent = text;
    }
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

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      // PING: background checks if content script is alive
      if (msg.type === "PING") {
        sendResponse({ pong: true });
        return;
      }

      if (!contextValid()) { startContextRecovery(); return; }

      if (msg.type === "SCORE_READY") {
        scores[msg.postKey] = { score: msg.score, reason: msg.reason, tldr: msg.tldr || "" };
        applyScoreToPost(msg.postKey);
      }

      if (msg.type === "NEED_API_KEY" && !apiKeyNotified) {
        apiKeyNotified = true;
        showApiKeyNotification();
      }
    });

    console.log("[AI Detector] v2.7 — feed + activity page support. Running initial scan...");
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
          // Re-apply debug highlights if active (e.g. after "… more" expands)
          if (debugHighlight) {
            const posts = document.querySelectorAll("[" + PROCESSED_ATTR + "]");
            for (const post of posts) {
              if (post.querySelector("." + HIGHLIGHT_CLASS)) continue; // already highlighted
              const pair = findDismissPair(post) || findActivityVirtualPair(post);
              highlightExtractedText(post, pair);
            }
          }
        }, 200);
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

  // Activity pages (and sometimes feed) can take a while to render
  // their post elements after the initial page load. The MutationObserver
  // handles ongoing mutations, but these delayed scans catch content that
  // renders in the gap between DOMContentLoaded and observer attachment.
  if (isSupportedPage()) {
    setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 500);
    setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 1500);
    setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 3000);
    setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 5000);
  }

  // ─── SPA navigation handler ──────────────────────────────────────────
  // LinkedIn uses history.pushState for SPA navigation (Home click, etc.).
  // We intercept pushState/replaceState for instant detection, plus
  // listen for popstate (back/forward), and keep a 1s poll as safety net.

  let lastPath = location.pathname;

  function onNavigate() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    zeroResultCount = 0;
    diagnosticNotified = false;
    if (isSupportedPage()) {
      // Immediate scan + delayed re-scans to catch late-rendering posts.
      boot();
      setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 500);
      setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 1500);
      setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 3000);
      setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 5000);

      // Activity pages reached via SPA ("Show all →") can take much longer
      // to render data-urn elements. Keep retrying up to 15s.
      if (isActivityPage()) {
        setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 7000);
        setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 10000);
        setTimeout(() => { try { scanAndApply(); } catch (e) {} }, 15000);
      }
    }
  }

  // Intercept history.pushState and replaceState
  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function () {
    origPushState.apply(this, arguments);
    onNavigate();
  };
  history.replaceState = function () {
    origReplaceState.apply(this, arguments);
    onNavigate();
  };

  // Back/forward button
  window.addEventListener("popstate", onNavigate);

  // LinkedIn sometimes navigates via link clicks without triggering pushState
  // immediately. Detect navigation after any click on a link.
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a[href]");
    if (!link) return;
    // Check URL after a short delay to let LinkedIn's router update
    setTimeout(onNavigate, 300);
    setTimeout(onNavigate, 800);
  }, true);

  // Re-scan when tab becomes visible (switching back to LinkedIn tab)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isSupportedPage() && contextValid()) {
      try { scanAndApply(); } catch (e) {}
    }
  });

  // Safety-net poll (1s instead of 2s)
  setInterval(() => {
    if (!contextValid()) { startContextRecovery(); return; }
    onNavigate();
  }, 1000);

})();
