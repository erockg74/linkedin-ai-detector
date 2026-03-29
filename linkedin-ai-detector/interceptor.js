// LinkedIn AI Post Detector v2 — Fetch/XHR Interceptor (injected into PAGE context)
// Captures LinkedIn feed API responses and extracts post data.

(function () {
  "use strict";

  // Guard against double injection
  if (window.__aiDetectorInterceptorInstalled) return;
  window.__aiDetectorInterceptorInstalled = true;

  const FEED_URL_PATTERNS = [
    /linkedin\.com\/voyager\/api\/feed/,
    /linkedin\.com\/voyager\/api\/graphql/,
    /linkedin\.com\/voyager\/api\/search/
  ];

  function matchesFeedUrl(url) {
    return FEED_URL_PATTERNS.some((p) => p.test(url));
  }

  // ─── Extract posts from LinkedIn's feed JSON ────────────────────────────

  function extractPosts(data) {
    const posts = [];

    try {
      // LinkedIn's API returns deeply nested structures.
      // We recursively search for objects that look like post data.
      walkObject(data, posts, 0);
    } catch (e) {
      // Don't break the page
    }

    return posts;
  }

  function walkObject(obj, posts, depth) {
    if (depth > 15 || !obj || typeof obj !== "object") return;

    // Look for activity URN patterns
    if (typeof obj === "object" && obj !== null) {
      // Check if this object has post-like properties
      const urn = obj.activityUrn || obj.urn || obj.entityUrn || obj["*urn"] || "";
      const isActivity = typeof urn === "string" && (
        urn.includes("urn:li:activity:") ||
        urn.includes("urn:li:ugcPost:") ||
        urn.includes("urn:li:share:")
      );

      if (isActivity) {
        // Try to find the text content
        const text = extractText(obj);
        const author = extractAuthor(obj);
        const activityUrn = normalizeUrn(urn);

        if (text && activityUrn) {
          posts.push({ activityUrn, text, author });
        }
      }

      // Also look for commentary/text fields that contain post content
      if (obj.commentary && obj.commentary.text) {
        const parentUrn = findParentUrn(obj);
        if (parentUrn) {
          posts.push({
            activityUrn: normalizeUrn(parentUrn),
            text: obj.commentary.text.text || obj.commentary.text,
            author: extractAuthor(obj)
          });
        }
      }
    }

    // Recurse into arrays and objects
    if (Array.isArray(obj)) {
      for (const item of obj) {
        walkObject(item, posts, depth + 1);
      }
    } else {
      for (const key of Object.keys(obj)) {
        try {
          walkObject(obj[key], posts, depth + 1);
        } catch (e) {}
      }
    }
  }

  function extractText(obj) {
    // Various places LinkedIn stores post text
    if (obj.commentary?.text?.text) return obj.commentary.text.text;
    if (obj.commentary?.text) return typeof obj.commentary.text === "string" ? obj.commentary.text : null;
    if (obj.text?.text) return obj.text.text;
    if (obj.originalContent?.text?.text) return obj.originalContent.text.text;
    if (obj.resharedUpdate?.commentary?.text?.text) return obj.resharedUpdate.commentary.text.text;
    if (typeof obj.text === "string" && obj.text.length > 20) return obj.text;
    return null;
  }

  function extractAuthor(obj) {
    if (obj.actor?.name?.text) return obj.actor.name.text;
    if (obj.actor?.name) return typeof obj.actor.name === "string" ? obj.actor.name : null;
    if (obj.author?.name) return obj.author.name;
    if (obj.authorName) return obj.authorName;
    return null;
  }

  function findParentUrn(obj) {
    return obj.activityUrn || obj.urn || obj.entityUrn || obj.updateUrn || null;
  }

  function normalizeUrn(urn) {
    // Extract the activity ID from various URN formats
    const match = urn.match(/(urn:li:(?:activity|ugcPost|share):\d+)/);
    return match ? match[1] : urn;
  }

  // ─── Deduplicate before sending ─────────────────────────────────────────

  const sentUrns = new Set();

  function sendPosts(posts) {
    const unique = posts.filter((p) => {
      if (sentUrns.has(p.activityUrn)) return false;
      sentUrns.add(p.activityUrn);
      return true;
    });

    if (unique.length === 0) return;

    // Send to content script via postMessage (page → content script)
    window.postMessage({
      type: "AI_DETECTOR_FEED_DATA",
      posts: unique
    }, "*");
  }

  // ─── Override fetch ─────────────────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (matchesFeedUrl(url)) {
        // Clone response so the original consumer isn't affected
        const clone = response.clone();
        clone.json().then((data) => {
          const posts = extractPosts(data);
          if (posts.length > 0) sendPosts(posts);
        }).catch(() => {});
      }
    } catch (e) {}

    return response;
  };

  // ─── Override XMLHttpRequest ────────────────────────────────────────────

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__aiDetectorUrl = url;
    return originalXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__aiDetectorUrl && matchesFeedUrl(this.__aiDetectorUrl)) {
      this.addEventListener("load", function () {
        try {
          const data = JSON.parse(this.responseText);
          const posts = extractPosts(data);
          if (posts.length > 0) sendPosts(posts);
        } catch (e) {}
      });
    }
    return originalXHRSend.apply(this, args);
  };

})();
