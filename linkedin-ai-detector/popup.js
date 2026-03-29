// LinkedIn AI Post Detector — Popup logic

const toggle = document.getElementById("toggle");
const scannedEl = document.getElementById("scanned");
const flaggedEl = document.getElementById("flagged");
const resetBtn = document.getElementById("reset");

// Load state
chrome.storage.local.get(["aiDetectorEnabled", "aiDetectorStats"], (res) => {
  toggle.checked = res.aiDetectorEnabled !== false; // default on
  const stats = res.aiDetectorStats || { scanned: 0, flagged: 0 };
  scannedEl.textContent = stats.scanned;
  flaggedEl.textContent = stats.flagged;
});

// Toggle
toggle.addEventListener("change", () => {
  chrome.storage.local.set({ aiDetectorEnabled: toggle.checked });
});

// Reset stats
resetBtn.addEventListener("click", () => {
  const fresh = { scanned: 0, flagged: 0 };
  chrome.storage.local.set({ aiDetectorStats: fresh });
  scannedEl.textContent = "0";
  flaggedEl.textContent = "0";
});
