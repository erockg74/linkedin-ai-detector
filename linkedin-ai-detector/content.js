// LinkedIn AI Post Detector — Content Script
// Pure client-side pattern matching. No data leaves the browser.
//
// STRATEGY: Anchor-first detection.
//   1. Find ALL text nodes on the page
//   2. Check each for 4 clear AI anchors:
//        - Em-dash (—) usage
//        - Non-human emoji (anything outside faces/hands/hearts)
//        - Single-sentence paragraph cadence (6+ lines, 70%+ one-liners)
//        - Hook + bullet list + CTA structure
//   3. Only when an anchor fires, walk UP the DOM to find the enclosing post
//   4. 1 anchor = yellow shading, 2+ anchors = red shading
//   5. Collapse media (images/video) in flagged posts

(function () {
  "use strict";

  // ─── Feed-page guard (checked every scan cycle) ─────────────────────
  // Only scan on the main feed and search results where posts appear.
  // Profiles, messaging, etc. are skipped but the script stays alive
  // so it activates if LinkedIn's SPA navigates back to the feed.
  function isFeedPage() {
    const path = location.pathname;
    return path === "/" || path === "/feed/" || path === "/feed"
      || path.startsWith("/search/") || path.startsWith("/posts/");
  }

  const PROCESSED_ATTR = "data-ai-detector-processed";
  const RESCAN_INTERVAL = 3000;
  let enabled = true;
  let stats = { scanned: 0, flagged: 0 };

  function contextValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  // ─── Load state ──────────────────────────────────────────────────────
  if (!contextValid()) return;
  chrome.storage.local.get(["aiDetectorEnabled", "aiDetectorStats"], (res) => {
    if (!contextValid()) return;
    if (res.aiDetectorEnabled === false) enabled = false;
    if (res.aiDetectorStats) stats = res.aiDetectorStats;
    if (enabled) boot();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (!contextValid()) { teardown(); return; }
    if (changes.aiDetectorEnabled) {
      enabled = changes.aiDetectorEnabled.newValue;
      if (enabled) {
        boot();
      } else {
        // Remove all shading
        document.querySelectorAll(".ai-detector-shaded").forEach((el) => {
          el.classList.remove("ai-detector-shaded", "ai-detector-yellow", "ai-detector-red");
        });
        document
          .querySelectorAll(`[${PROCESSED_ATTR}]`)
          .forEach((el) => el.removeAttribute(PROCESSED_ATTR));
      }
    }
    if (changes.aiDetectorStats) {
      stats = changes.aiDetectorStats.newValue;
    }
  });

  // ─── The 3 AI anchors ─────────────────────────────────────────────────
  //
  // These are the tells that make a human scroll past a post instantly.
  // Each returns true/false for a given text block.

  const ANCHORS = [
    {
      label: "Em-dash usage (\u2014)",
      test: (text) => /\u2014/.test(text),
    },
    {
      label: "Non-human emoji",
      test: (text) => {
        // Human emojis: faces, people, hand gestures, hearts
        // Anything outside these sets is an AI tell
        const HUMAN_EMOJI = /[\u{1F600}-\u{1F64F}\u{1F466}-\u{1F487}\u{1F3C2}-\u{1F3C4}\u{1F3CA}-\u{1F3CC}\u{1F46A}-\u{1F490}\u{1F500}-\u{1F567}\u{1F910}-\u{1F92F}\u{1F970}-\u{1F976}\u{1F978}-\u{1F97A}\u{1F9B0}-\u{1F9B9}\u{1F9D0}-\u{1F9FF}\u{1FAC0}-\u{1FAC5}\u{1FAE0}-\u{1FAE8}\u{2764}\u{FE0F}?\u{1F90D}-\u{1F90F}\u{1F493}-\u{1F49F}\u{1F491}\u{1F48B}\u{270B}\u{270C}\u{261D}\u{1F44A}-\u{1F44F}\u{1F450}\u{1F64C}\u{1F64F}\u{1F91A}-\u{1F91F}\u{1F932}-\u{1F933}\u{1FAF0}-\u{1FAF8}\u{1F9B5}\u{1F9B6}\u{1F595}\u{1F596}\u{1F448}-\u{1F44D}]/gu;
        // Get all emojis in text
        const allEmojis = text.match(
          /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu
        );
        if (!allEmojis || allEmojis.length === 0) return false;
        // Filter out human emojis
        const nonHuman = allEmojis.filter((e) => !HUMAN_EMOJI.test(e));
        return nonHuman.length >= 1;
      },
    },
    {
      label: "Single-sentence paragraphs",
      test: (text) => {
        // The AI cadence: 6+ lines where 70%+ are single sentences
        const lines = text.split(/\n/).filter((l) => l.trim());
        if (lines.length < 6) return false;
        const singleSentences = lines.filter((l) => {
          const sentences = l.split(/[.!?]+/).filter((s) => s.trim());
          return sentences.length <= 1;
        });
        return singleSentences.length / lines.length > 0.7;
      },
    },
    {
      label: "Hook + bullet list + CTA structure",
      test: (text) => {
        const lines = text.split("\n").filter((l) => l.trim());
        if (lines.length < 5) return false;

        // Hook: first line is short and punchy
        const hook = lines[0].trim();
        if (hook.length > 100) return false;

        // Bullets: 3+ lines with list markers
        const bulletLines = lines.filter((l) => {
          const t = l.trim();
          return /^(?:\d+[.\)]|[•\-\*→↳⟶⇒]|[\p{Emoji_Presentation}\p{Extended_Pictographic}])/u.test(t);
        });
        if (bulletLines.length < 3) return false;

        // CTA: last line is engagement bait
        const last = lines[lines.length - 1].trim();
        const isCTA = /[?]$/.test(last) ||
          /(?:agree|thoughts|comment|share|follow|repost|save this|bookmark|link in)/i.test(last);
        if (!isCTA) return false;

        return true;
      },
    },
  ];

  // ─── DOM walking helpers ───────────────────────────────────────────────

  // Tags to skip when walking up to find the post card
  const INLINE_TAGS = new Set([
    "SPAN", "A", "P", "STRONG", "EM", "B", "I", "U", "MARK",
    "SMALL", "SUB", "SUP", "LABEL", "ABBR", "CODE", "TIME",
  ]);

  /**
   * From a text element, walk up to find the visual post card —
   * first block-level ancestor wider than 300px and taller than 100px.
   */
  function findCard(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      try {
        if (!INLINE_TAGS.has(node.tagName)) {
          const r = node.getBoundingClientRect();
          if (r.width > 300 && r.height > 100) return node;
        }
      } catch (e) {}
      node = node.parentElement;
    }
    return null;
  }

  /**
   * From a card, find the post boundary — the outermost single-post
   * container. Checks WCAG roles first, then <li>, then geometry.
   */
  function findPostBoundary(card) {
    // role="listitem" (main feed)
    const listitem = card.closest('[role="listitem"]');
    if (listitem) return listitem;

    // <li> inside a feed list (activity page)
    const li = card.closest("li");
    if (li) {
      const parent = li.parentElement;
      if (parent && (parent.tagName === "UL" || parent.tagName === "OL")) {
        return li;
      }
    }

    // Walk up to find a direct child of a feed-like container
    const feedCandidates = document.querySelectorAll(
      '[role="list"], main, [role="main"]'
    );
    for (const feed of feedCandidates) {
      if (feed.contains(card)) {
        let el = card;
        while (el && el.parentElement !== feed && el !== document.body) {
          el = el.parentElement;
        }
        if (el && el.parentElement === feed) return el;
      }
    }

    return card;
  }

  // ─── Media container collapsing ─────────────────────────────────────────
  //
  // CSS hides the actual media elements (img, video, etc.) via
  // .ai-detector-shaded selectors. But the wrapper divs still take
  // up space. This function marks them for collapse.
  //
  // Strategy: check if every visible child of a container is hidden.
  // If so, the container is empty and should collapse.
  // Run multiple passes so inner wrappers collapse first, making
  // their parents eligible on the next pass.

  function isEffectivelyHidden(el) {
    try {
      const style = getComputedStyle(el);
      if (style.display === "none") return true;
      if (style.visibility === "hidden") return true;
      if (style.opacity === "0") return true;
      const r = el.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) return true;
    } catch (e) {}
    return false;
  }

  function collapseEmptyContainers(boundary) {
    for (let pass = 0; pass < 4; pass++) {
      boundary.querySelectorAll("div, figure, section, a, article").forEach((el) => {
        // Protect our own UI
        if (el.closest(".ai-detector-dot") || el.classList.contains("ai-detector-dot")) return;
        // Already collapsed
        if (el.classList.contains("ai-detector-media-kill")) return;
        // Must be taking up space to matter
        try {
          const r = el.getBoundingClientRect();
          if (r.height < 20) return;
        } catch (e) { return; }
        // Check: are ALL children effectively hidden?
        const children = el.children;
        if (children.length === 0) {
          // Leaf element with no text = collapse
          if ((el.innerText || "").trim().length === 0) {
            el.classList.add("ai-detector-media-kill");
          }
          return;
        }
        let allHidden = true;
        for (const child of children) {
          if (!isEffectivelyHidden(child)) {
            allHidden = false;
            break;
          }
        }
        if (allHidden) {
          el.classList.add("ai-detector-media-kill");
        }
      });
    }
  }

  // ─── Global tooltip ────────────────────────────────────────────────────
  let globalTooltip = null;
  function getTooltip() {
    if (!globalTooltip || !globalTooltip.parentNode) {
      globalTooltip = document.createElement("div");
      globalTooltip.className = "ai-detector-tooltip";
      document.body.appendChild(globalTooltip);
    }
    return globalTooltip;
  }

  // ─── Main scan ─────────────────────────────────────────────────────────

  function scanPage() {
    if (!enabled) return;
    if (!isFeedPage()) return; // SPA navigation guard

    // Phase 1: Find all substantial text elements on the page
    const textEls = document.querySelectorAll('p, span[dir="ltr"]');

    // Map: post boundary → { anchorsHit: Set, card }
    const hitMap = new Map();

    for (const el of textEls) {
      const text = (el.innerText || "").trim();
      if (text.length < 50) continue;

      // Skip headings / UI chrome
      if (el.closest("h2") || el.closest("h3") || el.closest("h4")) continue;

      // Check each anchor
      const hits = [];
      for (const anchor of ANCHORS) {
        try {
          if (anchor.test(text)) hits.push(anchor.label);
        } catch (e) {}
      }

      if (hits.length === 0) continue;

      // Found at least one anchor — walk up to find the post
      const card = findCard(el);
      if (!card) continue;

      const boundary = findPostBoundary(card);

      // Already fully processed
      if (boundary.getAttribute(PROCESSED_ATTR)) continue;

      if (!hitMap.has(boundary)) {
        hitMap.set(boundary, { anchors: new Set(), card });
      }
      const entry = hitMap.get(boundary);
      for (const h of hits) entry.anchors.add(h);
    }

    // Phase 2: Shade flagged posts
    for (const [boundary, { anchors, card }] of hitMap) {
      if (boundary.getAttribute(PROCESSED_ATTR)) continue;
      boundary.setAttribute(PROCESSED_ATTR, "1");

      const count = anchors.size;
      const level = count >= 2 ? "red" : "yellow";

      // Apply shading to the card (the visual container)
      card.classList.add("ai-detector-shaded", `ai-detector-${level}`);

      // Collapse empty media wrappers so the post shrinks vertically.
      // CSS handles hiding the media elements themselves (img, video, etc.)
      // via .ai-detector-red selectors — resilient to lazy loading.
      // JS just needs to collapse the now-empty wrapper divs.
      // Only collapse for red (2+ anchors); yellow posts keep their media.
      if (level === "red") {
        collapseEmptyContainers(boundary);
      }

      // Build tooltip content
      const labels = [...anchors];
      const levelLabel = level === "red" ? "Likely AI" : "Possibly AI";
      let tooltipHTML = `<strong>${levelLabel}</strong> (${count} anchor${count > 1 ? "s" : ""})<hr>`;
      tooltipHTML += labels.map((l) => `\u2022 ${l}`).join("<br>");

      // Add a small indicator dot for hover tooltip
      try {
        const pos = getComputedStyle(card).position;
        if (pos === "static") card.style.position = "relative";
      } catch (e) {}

      const dot = document.createElement("div");
      dot.className = `ai-detector-dot ai-detector-dot-${level}`;
      dot._tooltipHTML = tooltipHTML;

      dot.addEventListener("mouseenter", () => {
        const tip = getTooltip();
        tip.innerHTML = dot._tooltipHTML;
        const rect = dot.getBoundingClientRect();
        tip.style.top = rect.bottom + 6 + "px";
        tip.style.left = Math.max(8, rect.left - 134) + "px";
        tip.classList.add("ai-detector-tooltip--visible");
      });
      dot.addEventListener("mouseleave", () => {
        getTooltip().classList.remove("ai-detector-tooltip--visible");
      });

      card.appendChild(dot);

      stats.scanned++;
      stats.flagged++;
    }

    // Persist stats
    if (contextValid()) {
      try {
        chrome.storage.local.set({ aiDetectorStats: stats });
      } catch (e) {
        teardown();
      }
    }
  }

  // ─── Observer + periodic rescan ────────────────────────────────────────

  let observer = null;
  let rescanTimer = null;

  function teardown() {
    if (observer) { observer.disconnect(); observer = null; }
    if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
  }

  function boot() {
    scanPage();

    if (!observer) {
      observer = new MutationObserver(() => {
        if (!contextValid()) { teardown(); return; }
        clearTimeout(observer._debounce);
        observer._debounce = setTimeout(scanPage, 300);
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    if (!rescanTimer) {
      rescanTimer = setInterval(() => {
        if (!contextValid()) { teardown(); return; }
        // Re-check for recycled DOM elements that lost their shading
        document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach((el) => {
          if (!el.querySelector(".ai-detector-dot")) {
            el.r
