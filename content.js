(() => {
  if (window.__autoScrubSpeedInjected) return;
  window.__autoScrubSpeedInjected = true;

  const PREFIX = "asv";
  const DEFAULTS = {
    enabled: true,
    speechSpeed: 1.5,
    musicSpeed: 1.0,
    silenceSpeed: 1.5,
    overlay: true,
    overlapBias: 0.1,
  };

  const state = {
    settings: { ...DEFAULTS },
    media: null,
    ctx: null,
    source: null,
    analyser: null,
    stream: null,
    classifier: new AutoScrub.Classifier(),
    overlay: null,
    timer: 0,
    lastTick: 0,
    td: null,
    fd: null,
    mode: "silence",
    appliedRate: 1,
    targetRate: 1,
    lastStatusAt: 0,
  };

  function speedFor(mode) {
    const s = state.settings;
    if (mode === "music") return s.musicSpeed;
    if (mode === "speech") return s.speechSpeed;
    return s.silenceSpeed;
  }

  function isUsableMedia(el) {
    if (!el) return false;
    if (el.tagName !== "VIDEO" && el.tagName !== "AUDIO") return false;
    if (el.ended || el.readyState < 1) return false;
    return true;
  }

  function visibleArea(el) {
    if (el.tagName === "AUDIO") return 1;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return 0;
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    return w * h;
  }

  function pickMedia() {
    const nodes = document.querySelectorAll("video, audio");
    let best = null;
    let bestScore = -1;
    for (const el of nodes) {
      if (!isUsableMedia(el)) continue;
      const playing = !el.paused && !el.ended ? 1e9 : 0;
      const area = visibleArea(el);
      const dur = Number.isFinite(el.duration) ? Math.min(el.duration, 1e7) : 0;
      const score = playing + area + dur * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function teardownAudio() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = 0;
    }
    try {
      if (state.source) state.source.disconnect();
    } catch (_) {}
    if (state.stream) {
      for (const t of state.stream.getTracks()) {
        try {
          t.stop();
        } catch (_) {}
      }
    }
    state.source = null;
    state.analyser = null;
    state.stream = null;
    state.td = null;
    state.fd = null;
  }

  function attachAudio(media) {
    teardownAudio();
    if (!media.captureStream && !media.mozCaptureStream) {
      console.warn("[Auto Scrub Speed] captureStream is not available on this element.");
      return false;
    }
    let stream;
    try {
      stream = (media.captureStream || media.mozCaptureStream).call(media);
    } catch (err) {
      console.warn("[Auto Scrub Speed] captureStream failed (DRM or not ready).", err);
      return false;
    }
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      return false;
    }
    const audioStream = new MediaStream(audioTracks);
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!state.ctx) state.ctx = new Ctx();
    if (state.ctx.state === "suspended") {
      state.ctx.resume().catch(() => {});
    }
    const source = state.ctx.createMediaStreamSource(audioStream);
    const analyser = state.ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.35;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -20;
    source.connect(analyser);

    state.stream = audioStream;
    state.source = source;
    state.analyser = analyser;
    state.td = new Float32Array(analyser.fftSize);
    state.fd = new Float32Array(analyser.frequencyBinCount);
    state.classifier.reset();
    state.classifier.setOptions({ overlapBias: state.settings.overlapBias });
    state.lastTick = performance.now();
    state.timer = setInterval(tick, 40);
    return true;
  }

  function detachMedia() {
    teardownAudio();
    if (state.mediaAbort) {
      state.mediaAbort.abort();
      state.mediaAbort = null;
    }
    state.media = null;
    hideOverlay();
  }

  function bindMedia(media) {
    if (state.media === media && state.analyser) return;
    detachMedia();
    state.media = media;
    if (state.mediaAbort) state.mediaAbort.abort();
    state.mediaAbort = new AbortController();
    const { signal } = state.mediaAbort;
    if (!state.settings.enabled) return;
    const tryAttach = () => {
      if (state.media !== media) return;
      if (!attachAudio(media)) {
        setTimeout(tryAttach, 800);
      }
    };
    const resume = () => {
      if (state.ctx && state.ctx.state === "suspended") {
        state.ctx.resume().catch(() => {});
      }
    };
    media.addEventListener("play", resume, { signal });
    media.addEventListener("playing", () => {
      resume();
      if (!state.analyser && state.media === media) tryAttach();
    }, { signal });
    tryAttach();
  }

  function tick() {
    if (!state.settings.enabled) return;
    const media = state.media;
    const analyser = state.analyser;
    if (!media || !analyser) return;
    if (document.hidden || media.paused || media.ended) {
      positionOverlay();
      return;
    }
    if (state.ctx && state.ctx.state === "suspended") {
      state.ctx.resume().catch(() => {});
      return;
    }

    analyser.getFloatTimeDomainData(state.td);
    analyser.getFloatFrequencyData(state.fd);
    const spectrum = AutoScrub.spectrumFromDb(state.fd);
    const features = AutoScrub.extractFeatures(
      state.td,
      spectrum,
      state.ctx.sampleRate,
      analyser.fftSize
    );
    features.spectrum = spectrum;

    const now = performance.now();
    const dt = now - state.lastTick;
    state.lastTick = now;

    const result = state.classifier.update(features, dt, media.playbackRate || 1);
    state.mode = result.mode;
    const target = speedFor(result.mode === "silence" ? result.lastVoiced || "speech" : result.mode);
    state.targetRate = target;

    const current = media.playbackRate || 1;
    const next = current + (target - current) * Math.min(1, dt / 220);
    if (Math.abs(next - current) > 0.008 || Math.abs(current - target) > 0.04) {
      try {
        media.preservesPitch = true;
        media.playbackRate = Math.round(next * 100) / 100;
        state.appliedRate = media.playbackRate;
      } catch (_) {}
    }

    updateOverlay(result);
    if (now - state.lastStatusAt > 400) {
      state.lastStatusAt = now;
      notifyBackground(result);
    }
  }

  function ensureOverlay() {
    if (state.overlay) return state.overlay;
    const root = document.createElement("div");
    root.id = `${PREFIX}-overlay`;
    root.innerHTML = `
      <div class="${PREFIX}-pill">
        <span class="${PREFIX}-dot"></span>
        <span class="${PREFIX}-mode">Idle</span>
        <span class="${PREFIX}-speed">1.00×</span>
      </div>`;
    const style = document.createElement("style");
    style.textContent = `
      #${PREFIX}-overlay {
        position: fixed;
        z-index: 2147483646;
        pointer-events: none;
        font-family: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
        letter-spacing: 0.01em;
      }
      #${PREFIX}-overlay .${PREFIX}-pill {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px 6px 8px;
        border-radius: 999px;
        background: rgba(10, 12, 16, 0.82);
        color: #f4f1ea;
        border: 1px solid rgba(255,255,255,0.08);
        box-shadow: 0 8px 24px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px);
        font-size: 12px;
        line-height: 1;
      }
      #${PREFIX}-overlay .${PREFIX}-dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #8b909a;
        box-shadow: 0 0 0 3px rgba(139,144,154,0.2);
      }
      #${PREFIX}-overlay .${PREFIX}-mode { font-weight: 600; }
      #${PREFIX}-overlay .${PREFIX}-speed {
        font-variant-numeric: tabular-nums;
        color: rgba(244,241,234,0.72);
      }
      #${PREFIX}-overlay[data-mode="music"] .${PREFIX}-dot {
        background: #3ee0c4;
        box-shadow: 0 0 0 3px rgba(62,224,196,0.22);
      }
      #${PREFIX}-overlay[data-mode="speech"] .${PREFIX}-dot {
        background: #ffb020;
        box-shadow: 0 0 0 3px rgba(255,176,32,0.22);
      }
      #${PREFIX}-overlay[data-mode="silence"] .${PREFIX}-dot {
        background: #8b909a;
      }
    `;
    root.appendChild(style);
    mountOverlay(root);
    state.overlay = root;
    return root;
  }

  function mountOverlay(el) {
    const host = document.fullscreenElement || document.documentElement;
    if (el.parentNode !== host) host.appendChild(el);
  }

  function hideOverlay() {
    if (state.overlay) state.overlay.style.display = "none";
  }

  function updateOverlay(result) {
    if (!state.settings.overlay || !state.settings.enabled) {
      hideOverlay();
      return;
    }
    const el = ensureOverlay();
    mountOverlay(el);
    el.style.display = "block";
    const mode = result.mode;
    el.dataset.mode = mode;
    const labels = { music: "Music", speech: "Talking", silence: "Silence" };
    el.querySelector(`.${PREFIX}-mode`).textContent = labels[mode] || mode;
    el.querySelector(`.${PREFIX}-speed`).textContent =
      `${(state.media && state.media.playbackRate ? state.media.playbackRate : state.targetRate).toFixed(2)}×`;
    positionOverlay();
  }

  function positionOverlay() {
    const el = state.overlay;
    const media = state.media;
    if (!el || el.style.display === "none") return;
    if (!media || media.tagName === "AUDIO") {
      el.style.top = "16px";
      el.style.left = "16px";
      return;
    }
    const r = media.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) {
      el.style.display = "none";
      return;
    }
    el.style.top = `${Math.max(8, r.top + 12)}px`;
    el.style.left = `${Math.max(8, r.left + 12)}px`;
  }

  function notifyBackground(result) {
    try {
      chrome.runtime.sendMessage({
        type: "STATUS",
        mode: result.mode,
        speed: state.media ? state.media.playbackRate : state.targetRate,
        speech: result.speech,
        music: result.music,
        enabled: state.settings.enabled,
      });
    } catch (_) {}
  }

  function applySettings(next) {
    const wasEnabled = state.settings.enabled;
    state.settings = { ...DEFAULTS, ...state.settings, ...next };
    state.classifier.setOptions({ overlapBias: state.settings.overlapBias });
    if (!state.settings.enabled) {
      if (state.media) {
        try {
          state.media.playbackRate = 1;
        } catch (_) {}
      }
      teardownAudio();
      hideOverlay();
    } else if (!wasEnabled || !state.analyser) {
      scan();
    }
  }

  function snapshot() {
    return {
      type: "STATUS",
      enabled: state.settings.enabled,
      mode: state.mode,
      speed: state.media ? state.media.playbackRate : state.targetRate,
      speech: state.classifier.speechEma,
      music: state.classifier.musicEma,
      hasMedia: Boolean(state.media),
      settings: state.settings,
    };
  }

  function scan() {
    if (!state.settings.enabled) {
      hideOverlay();
      return;
    }
    const media = pickMedia();
    if (!media) {
      if (state.media && !state.media.isConnected) detachMedia();
      return;
    }
    if (media !== state.media) bindMedia(media);
    else if (!state.analyser && !media.paused) attachAudio(media);
    positionOverlay();
  }

  chrome.storage.local.get(DEFAULTS, (stored) => {
    applySettings(stored);
    scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const patch = {};
    for (const [k, v] of Object.entries(changes)) patch[k] = v.newValue;
    applySettings(patch);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "GET_STATUS") {
      sendResponse(snapshot());
      return;
    }
    if (msg.type === "SET_SETTINGS") {
      chrome.storage.local.set(msg.settings || {});
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "TOGGLE") {
      const enabled = !state.settings.enabled;
      chrome.storage.local.set({ enabled });
      sendResponse({ enabled });
    }
  });

  const mo = new MutationObserver(() => {
    if (!state._scanSoon) {
      state._scanSoon = true;
      setTimeout(() => {
        state._scanSoon = false;
        scan();
      }, 400);
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener("play", (e) => {
    const t = e.target;
    if (t && (t.tagName === "VIDEO" || t.tagName === "AUDIO")) scan();
  }, true);

  window.addEventListener("yt-navigate-finish", scan);
  document.addEventListener("fullscreenchange", () => {
    if (state.overlay) mountOverlay(state.overlay);
    positionOverlay();
  });
  window.addEventListener("resize", positionOverlay);
  window.addEventListener("scroll", positionOverlay, true);

  setInterval(scan, 2000);
})();
