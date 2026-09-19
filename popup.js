const hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

const DEFAULTS = {
  enabled: true,
  speechSpeed: 1.5,
  musicSpeed: 1.0,
  silenceSpeed: 1.5,
  overlay: true,
  overlapBias: 0.1,
};

const $ = (id) => document.getElementById(id);

function fmtSpeed(v) {
  return Number(v).toFixed(2) + "×";
}

function biasLabel(v) {
  const n = Number(v);
  if (n < -0.04) return "talking";
  if (n > 0.12) return "music";
  return "balanced";
}

function paintSettings(s) {
  $("enabled").checked = Boolean(s.enabled);
  $("speechSpeed").value = s.speechSpeed;
  $("musicSpeed").value = s.musicSpeed;
  $("overlapBias").value = s.overlapBias;
  $("overlay").checked = Boolean(s.overlay);
  $("speechVal").textContent = fmtSpeed(s.speechSpeed);
  $("musicVal").textContent = fmtSpeed(s.musicSpeed);
  $("biasVal").textContent = biasLabel(s.overlapBias);
}

function paintStatus(st) {
  const now = $("now");
  if (!st || !st.hasMedia) {
    now.dataset.mode = "";
    $("nowMode").textContent = st && st.enabled === false ? "Paused" : "Looking for a video…";
    $("nowSpeed").textContent = "";
    $("meterFill").style.left = "50%";
    return;
  }
  const mode = st.mode || "silence";
  now.dataset.mode = mode;
  const labels = { music: "Music", speech: "Talking", silence: "Silence" };
  $("nowMode").textContent = labels[mode] || mode;
  $("nowSpeed").textContent = st.speed ? fmtSpeed(st.speed) : "";
  const speech = Number(st.speech) || 0;
  const music = Number(st.music) || 0;
  const mix = speech + music;
  const t = mix < 1e-6 ? 0.5 : music / mix;
  $("meterFill").style.left = `${Math.round(t * 100)}%`;
}

function persistFromInputs() {
  const settings = {
    enabled: $("enabled").checked,
    speechSpeed: Number($("speechSpeed").value),
    musicSpeed: Number($("musicSpeed").value),
    overlay: $("overlay").checked,
    overlapBias: Number($("overlapBias").value),
  };
  paintSettings({ ...DEFAULTS, ...settings });
  if (hasChrome) chrome.storage.local.set(settings);
}

["enabled", "speechSpeed", "musicSpeed", "overlapBias", "overlay"].forEach((id) => {
  $(id).addEventListener("input", persistFromInputs);
  $(id).addEventListener("change", persistFromInputs);
});

if (hasChrome) {
  chrome.storage.local.get(DEFAULTS, paintSettings);
} else {
  paintSettings(DEFAULTS);
}

async function poll() {
  if (!hasChrome || !chrome.tabs) {
    paintStatus(null);
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    paintStatus(null);
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: "GET_STATUS" }, (res) => {
    if (chrome.runtime.lastError) {
      paintStatus(null);
      return;
    }
    paintStatus(res);
  });
}

poll();
if (hasChrome) setInterval(poll, 350);
