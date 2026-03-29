// LinkedIn AI Post Detector v2 — Popup logic

const apiKeyInput = document.getElementById("apiKey");
const saveKeyBtn = document.getElementById("saveKey");
const apiStatus = document.getElementById("apiStatus");
const thresholdSlider = document.getElementById("threshold");
const thresholdValue = document.getElementById("thresholdValue");
const scannedEl = document.getElementById("scanned");
const collapsedEl = document.getElementById("collapsed");
const resetBtn = document.getElementById("reset");

// ─── Load state ──────────────────────────────────────────────────────────

chrome.storage.local.get(
  ["aiDetectorApiKey", "aiDetectorThreshold", "aiDetectorStats"],
  (res) => {
    // API key
    if (res.aiDetectorApiKey) {
      apiKeyInput.value = res.aiDetectorApiKey;
      apiStatus.textContent = "Key saved";
      apiStatus.className = "api-status ok";
    } else {
      apiStatus.textContent = "No API key set";
      apiStatus.className = "api-status missing";
    }

    // Threshold
    const t = res.aiDetectorThreshold ?? 70;
    thresholdSlider.value = t;
    thresholdValue.textContent = t + "%";

    // Stats
    const stats = res.aiDetectorStats || { scanned: 0, collapsed: 0 };
    scannedEl.textContent = stats.scanned;
    collapsedEl.textContent = stats.collapsed;
  }
);

// ─── Save API key ────────────────────────────────────────────────────────

saveKeyBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    apiStatus.textContent = "Please enter an API key";
    apiStatus.className = "api-status missing";
    return;
  }

  chrome.storage.local.set({ aiDetectorApiKey: key }, () => {
    apiStatus.textContent = "Key saved";
    apiStatus.className = "api-status ok";
    saveKeyBtn.textContent = "Saved";
    saveKeyBtn.classList.add("saved");
    setTimeout(() => {
      saveKeyBtn.textContent = "Save";
      saveKeyBtn.classList.remove("saved");
    }, 2000);
  });
});

// Also save on Enter
apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveKeyBtn.click();
});

// ─── Threshold slider ────────────────────────────────────────────────────

thresholdSlider.addEventListener("input", () => {
  const val = parseInt(thresholdSlider.value, 10);
  thresholdValue.textContent = val + "%";
});

thresholdSlider.addEventListener("change", () => {
  const val = parseInt(thresholdSlider.value, 10);
  chrome.storage.local.set({ aiDetectorThreshold: val });
});

// ─── Reset stats ─────────────────────────────────────────────────────────

resetBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "RESET_STATS" });
  scannedEl.textContent = "0";
  collapsedEl.textContent = "0";
});

// ─── Live stats updates ──────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes) => {
  if (changes.aiDetectorStats) {
    const stats = changes.aiDetectorStats.newValue || { scanned: 0, collapsed: 0 };
    scannedEl.textContent = stats.scanned;
    collapsedEl.textContent = stats.collapsed;
  }
});
