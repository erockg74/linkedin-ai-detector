// LinkedIn AI Post Detector v2.4 — Popup logic
// Filter strength: Aggressive (30) / Permissive (70) / Off (101)
// Slider shows position without numbers. Off disables the slider.

const apiKeyInput = document.getElementById("apiKey");
const saveKeyBtn = document.getElementById("saveKey");
const testKeyBtn = document.getElementById("testKey");
const apiStatus = document.getElementById("apiStatus");
const slider = document.getElementById("sensitivity");
const descEl = document.getElementById("sensitivityDesc");
const presetAggressive = document.getElementById("presetAggressive");
const presetPermissive = document.getElementById("presetPermissive");
const presetOff = document.getElementById("presetOff");
const scannedEl = document.getElementById("scanned");
const collapsedEl = document.getElementById("collapsed");
const resetBtn = document.getElementById("reset");

// Preset values (internal thresholds)
const AGGRESSIVE = 30;
const PERMISSIVE = 70;
const OFF = 101;  // nothing scores above 100, so nothing collapses

// ─── Load state ──────────────────────────────────────────────────────────

chrome.storage.local.get(
  ["aiDetectorApiKey", "aiDetectorThreshold", "aiDetectorStats"],
  (res) => {
    if (res.aiDetectorApiKey) {
      apiKeyInput.value = res.aiDetectorApiKey;
      apiStatus.textContent = "Key saved";
      apiStatus.className = "api-status ok";
    } else {
      apiStatus.textContent = "No API key set";
      apiStatus.className = "api-status missing";
    }

    const t = res.aiDetectorThreshold ?? PERMISSIVE;
    applyThreshold(t, false);

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

apiKeyInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveKeyBtn.click();
});

// ─── Test API key ─────────────────────────────────────────────────────────

testKeyBtn.addEventListener("click", async () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    apiStatus.textContent = "Enter a key first";
    apiStatus.className = "api-status missing";
    return;
  }

  testKeyBtn.textContent = "Testing...";
  testKeyBtn.classList.add("testing");
  testKeyBtn.disabled = true;
  apiStatus.textContent = "Testing key...";
  apiStatus.className = "api-status testing";

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{ role: "user", content: "Say OK" }]
      })
    });

    if (response.ok) {
      apiStatus.textContent = "Key works!";
      apiStatus.className = "api-status ok";
      testKeyBtn.textContent = "Pass";
      testKeyBtn.classList.remove("testing");
      testKeyBtn.classList.add("pass");
    } else {
      const err = await response.json().catch(() => ({}));
      const msg = err.error?.message || `HTTP ${response.status}`;
      apiStatus.textContent = msg;
      apiStatus.className = "api-status missing";
      testKeyBtn.textContent = "Fail";
      testKeyBtn.classList.remove("testing");
      testKeyBtn.classList.add("fail");
    }
  } catch (e) {
    apiStatus.textContent = "Network error: " + e.message;
    apiStatus.className = "api-status missing";
    testKeyBtn.textContent = "Fail";
    testKeyBtn.classList.remove("testing");
    testKeyBtn.classList.add("fail");
  }

  testKeyBtn.disabled = false;
  setTimeout(() => {
    testKeyBtn.textContent = "Test";
    testKeyBtn.classList.remove("pass", "fail");
  }, 3000);
});

// ─── Sensitivity presets & slider ────────────────────────────────────────

function applyThreshold(val, save) {
  // Update preset highlights
  presetAggressive.classList.toggle("active", val === AGGRESSIVE);
  presetPermissive.classList.toggle("active", val === PERMISSIVE);
  presetOff.classList.toggle("active", val >= OFF);

  // Update slider
  if (val >= OFF) {
    slider.disabled = true;
    slider.value = 50; // neutral midpoint when off
  } else {
    slider.disabled = false;
    slider.value = val;
  }

  // Update description
  if (val >= OFF) {
    descEl.textContent = "Scores shown, no posts hidden";
  } else if (val <= 30) {
    descEl.textContent = "Hiding most AI-suspected posts";
  } else if (val >= 65) {
    descEl.textContent = "Only hiding obvious AI posts";
  } else {
    descEl.textContent = "Balanced filtering";
  }

  if (save) {
    chrome.storage.local.set({ aiDetectorThreshold: val });
  }
}

presetAggressive.addEventListener("click", () => applyThreshold(AGGRESSIVE, true));
presetPermissive.addEventListener("click", () => applyThreshold(PERMISSIVE, true));
presetOff.addEventListener("click", () => applyThreshold(OFF, true));

let sliderDebounce = null;
slider.addEventListener("input", () => {
  const val = parseInt(slider.value, 10);
  // Clear Off state when slider is moved
  presetAggressive.classList.toggle("active", val === AGGRESSIVE);
  presetPermissive.classList.toggle("active", val === PERMISSIVE);
  presetOff.classList.remove("active");

  if (val <= 30) {
    descEl.textContent = "Hiding most AI-suspected posts";
  } else if (val >= 65) {
    descEl.textContent = "Only hiding obvious AI posts";
  } else {
    descEl.textContent = "Balanced filtering";
  }

  clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => {
    chrome.storage.local.set({ aiDetectorThreshold: val });
  }, 150);
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
