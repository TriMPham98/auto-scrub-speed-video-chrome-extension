(() => {
  const vid = document.getElementById("vid");
  const modeEl = document.getElementById("mode");
  const speedEl = document.getElementById("speed");
  const speechBar = document.getElementById("speechBar");
  const musicBar = document.getElementById("musicBar");
  const hint = document.getElementById("hint");

  let ctx;
  let dest;
  let analyser;
  let classifier;
  let timer = 0;
  let nodes = [];
  let kind = "silence";

  function audio() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    dest = ctx.createMediaStreamDestination();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.35;
    const mix = ctx.createGain();
    mix.gain.value = 0.9;
    mix.connect(dest);
    mix.connect(analyser);
    mix.connect(ctx.destination);
    ctx._mix = mix;
    vid.srcObject = dest.stream;
    classifier = new AutoScrub.Classifier();
    const td = new Float32Array(analyser.fftSize);
    const fd = new Float32Array(analyser.frequencyBinCount);
    let last = performance.now();
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(td);
      analyser.getFloatFrequencyData(fd);
      const spec = AutoScrub.spectrumFromDb(fd);
      const feat = AutoScrub.extractFeatures(td, spec, ctx.sampleRate, analyser.fftSize);
      feat.spectrum = spec;
      const now = performance.now();
      const r = classifier.update(feat, now - last, vid.playbackRate || 1);
      last = now;
      const labels = { music: "Music", speech: "Talking", silence: "Silence" };
      modeEl.textContent = labels[r.mode];
      modeEl.className = "v " + r.mode;
      const voiced = r.mode === "silence" ? r.lastVoiced || "speech" : r.mode;
      const speed = voiced === "music" ? 1 : 1.5;
      speedEl.textContent = speed.toFixed(2) + "×";
      const tot = r.speech + r.music + 0.001;
      speechBar.style.width = `${Math.min(100, (r.speech / tot) * 100)}%`;
      musicBar.style.width = `${Math.min(100, (r.music / tot) * 100)}%`;
    }, 40);
    return ctx;
  }

  function stopNodes() {
    for (const n of nodes) {
      try {
        n.stop();
      } catch (_) {}
      try {
        n.disconnect();
      } catch (_) {}
    }
    nodes = [];
  }

  function noiseSource() {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    return src;
  }

  function playSpeech() {
    const noise = noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1100;
    bp.Q.value = 0.8;
    const am = ctx.createGain();
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.45;
    am.gain.value = 0.5;
    lfo.connect(lfoGain);
    lfoGain.connect(am.gain);
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const now = ctx.currentTime;
    for (let i = 0; i < 80; i++) {
      const t = now + i * 0.26;
      gate.gain.setValueAtTime(0.9, t);
      gate.gain.exponentialRampToValueAtTime(0.04, t + 0.18);
    }
    noise.connect(bp);
    bp.connect(am);
    am.connect(gate);
    gate.connect(ctx._mix);
    noise.start();
    lfo.start();
    nodes.push(noise, lfo, bp, am, gate);
  }

  function playMusic() {
    const freqs = [110, 220, 330, 440, 554];
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.12;
      osc.connect(g);
      g.connect(ctx._mix);
      osc.start();
      nodes.push(osc, g);
    }
    const kick = ctx.createOscillator();
    kick.frequency.value = 55;
    const kickG = ctx.createGain();
    kickG.gain.value = 0;
    kick.connect(kickG);
    kickG.connect(ctx._mix);
    kick.start();
    const now = ctx.currentTime;
    for (let i = 0; i < 64; i++) {
      const t = now + i * 0.5;
      kick.frequency.setValueAtTime(90, t);
      kick.frequency.exponentialRampToValueAtTime(40, t + 0.08);
      kickG.gain.setValueAtTime(0.9, t);
      kickG.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    }
    nodes.push(kick, kickG);
  }

  async function setKind(next) {
    kind = next;
    audio();
    await ctx.resume();
    stopNodes();
    if (kind !== "silence") classifier.reset();
    if (kind === "speech") playSpeech();
    if (kind === "music") playMusic();
    if (kind === "mix") {
      playSpeech();
      playMusic();
    }
    document.querySelectorAll(".btns button").forEach((b) => b.setAttribute("aria-pressed", "false"));
    const map = { speech: "btnSpeech", music: "btnMusic", mix: "btnMix", silence: "btnStop" };
    document.getElementById(map[kind]).setAttribute("aria-pressed", "true");
    hint.textContent =
      kind === "music"
        ? "Should hold 1.00× so the song stays musical."
        : kind === "speech"
          ? "Should rise to 1.50× while someone is talking."
          : kind === "mix"
            ? "Music wins ties — stays near 1.00×."
            : "Silence holds the last voiced speed.";
    try {
      await vid.play();
    } catch (_) {}
  }

  document.getElementById("btnSpeech").onclick = () => setKind("speech");
  document.getElementById("btnMusic").onclick = () => setKind("music");
  document.getElementById("btnMix").onclick = () => setKind("mix");
  document.getElementById("btnStop").onclick = () => setKind("silence");
})();
