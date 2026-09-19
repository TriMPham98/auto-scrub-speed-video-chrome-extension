/**
 * Local speech-vs-music classifier for Auto Scrub Speed.
 *
 * Runs entirely in the page. No audio is recorded or sent anywhere.
 *
 * Policy: if music is present (including singing / rap over a beat), hold 1×.
 * Speed up only when the signal looks like talking without a musical bed.
 */

(function (root) {
  const TAU = Math.PI * 2;

  const DEFAULTS = {
    silenceRms: 0.008,
    // Positive overlapBias prefers music when scores are close.
    overlapBias: 0.1,
    speechHoldMs: 280,
    musicHoldMs: 850,
    silenceHoldMs: 900,
    historyMs: 1800,
  };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function mean(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function variance(arr, m) {
    if (arr.length < 2) return 0;
    const mu = m == null ? mean(arr) : m;
    let s = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - mu;
      s += d * d;
    }
    return s / arr.length;
  }

  /**
   * Radix-2 magnitude spectrum. Returns bins 0..N/2-1 (linear magnitude).
   */
  function magnitudeSpectrum(frame, fftSize) {
    const n = fftSize;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const copy = Math.min(frame.length, n);
    for (let i = 0; i < copy; i++) re[i] = frame[i];

    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
      let m = n >> 1;
      while (m >= 1 && j >= m) {
        j -= m;
        m >>= 1;
      }
      j += m;
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const ang = -TAU / size;
      const wrStep = Math.cos(ang);
      const wiStep = Math.sin(ang);
      for (let i = 0; i < n; i += size) {
        let wr = 1;
        let wi = 0;
        for (let k = 0; k < half; k++) {
          const ur = re[i + k];
          const ui = im[i + k];
          const vr = re[i + k + half] * wr - im[i + k + half] * wi;
          const vi = re[i + k + half] * wi + im[i + k + half] * wr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[i + k + half] = ur - vr;
          im[i + k + half] = ui - vi;
          const nwr = wr * wrStep - wi * wiStep;
          wi = wr * wiStep + wi * wrStep;
          wr = nwr;
        }
      }
    }

    const bins = n >> 1;
    const mag = new Float32Array(bins);
    const scale = 1 / n;
    for (let i = 0; i < bins; i++) {
      mag[i] = Math.hypot(re[i], im[i]) * scale;
    }
    return mag;
  }

  /**
   * One-pole bandpass via biquad (Audio EQ Cookbook).
   */
  function makeBandpass(fs, f0, q) {
    const w0 = TAU * (f0 / fs);
    const alpha = Math.sin(w0) / (2 * q);
    const b0 = alpha;
    const b1 = 0;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * Math.cos(w0);
    const a2 = 1 - alpha;
    const c = {
      b0: b0 / a0,
      b1: b1 / a0,
      b2: b2 / a0,
      a1: a1 / a0,
      a2: a2 / a0,
      x1: 0,
      x2: 0,
      y1: 0,
      y2: 0,
    };
    return function step(x) {
      const y = c.b0 * x + c.b1 * c.x1 + c.b2 * c.x2 - c.a1 * c.y1 - c.a2 * c.y2;
      c.x2 = c.x1;
      c.x1 = x;
      c.y2 = c.y1;
      c.y1 = y;
      return y;
    };
  }

  /**
   * Peak autocorrelation in a lag range, normalized 0..1.
   */
  function peakAutocorr(series, minLag, maxLag) {
    const n = series.length;
    if (n < maxLag + 4) return 0;
    const mu = mean(series);
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const d = series[i] - mu;
      energy += d * d;
    }
    if (energy < 1e-12) return 0;
    let best = 0;
    const lo = Math.max(1, minLag | 0);
    const hi = Math.min(n - 2, maxLag | 0);
    for (let lag = lo; lag <= hi; lag++) {
      let acc = 0;
      const lim = n - lag;
      for (let i = 0; i < lim; i++) {
        acc += (series[i] - mu) * (series[i + lag] - mu);
      }
      const corr = acc / energy;
      if (corr > best) best = corr;
    }
    return clamp(best, 0, 1);
  }

  function extractFeatures(timeDomain, spectrum, sampleRate, fftSize) {
    const n = timeDomain.length;
    let sumSq = 0;
    let zcr = 0;
    let prev = timeDomain[0] || 0;
    for (let i = 0; i < n; i++) {
      const x = timeDomain[i];
      sumSq += x * x;
      if ((prev >= 0) !== (x >= 0)) zcr++;
      prev = x;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, n));
    const zcrRate = zcr / Math.max(1, n);

    const binHz = sampleRate / fftSize;
    let total = 0;
    let bass = 0;
    let speech = 0;
    let high = 0;
    let weighted = 0;
    let logSum = 0;
    let linSum = 0;
    let count = 0;

    const bins = spectrum.length;
    for (let i = 1; i < bins; i++) {
      const hz = i * binHz;
      if (hz > 11000) break;
      const mag = spectrum[i];
      const power = mag * mag;
      total += power;
      weighted += power * hz;
      if (hz < 180) bass += power;
      if (hz >= 280 && hz <= 3600) speech += power;
      if (hz >= 4500) high += power;
      if (mag > 1e-9) {
        logSum += Math.log(mag);
        linSum += mag;
        count++;
      }
    }

    const centroid = total > 1e-12 ? weighted / total : 0;
    const flatness =
      count > 8 && linSum > 0
        ? Math.exp(logSum / count) / (linSum / count)
        : 0.5;
    const invTotal = total > 1e-12 ? 1 / total : 0;

    return {
      rms,
      zcrRate,
      centroid,
      flatness: clamp(flatness, 0, 1),
      bassRatio: bass * invTotal,
      speechRatio: speech * invTotal,
      highRatio: high * invTotal,
    };
  }

  /**
   * Convert AnalyserNode dB bins to linear magnitude.
   */
  function spectrumFromDb(dbBins) {
    const mag = new Float32Array(dbBins.length);
    for (let i = 0; i < dbBins.length; i++) {
      const db = dbBins[i];
      mag[i] = db > -140 ? Math.pow(10, db / 20) : 0;
    }
    return mag;
  }

  class Classifier {
    constructor(options) {
      this.opts = Object.assign({}, DEFAULTS, options || {});
      this.reset();
    }

    reset() {
      this.rmsHist = [];
      this.fluxHist = [];
      this.zcrHist = [];
      this.centHist = [];
      this.prevSpec = null;
      this.mode = "silence";
      this.pending = null;
      this.pendingMs = 0;
      this.silenceMs = 0;
      this.speechEma = 0;
      this.musicEma = 0;
      this.lastVoiced = "speech";
      this._bp4 = null;
      this._bp2 = null;
      this._bpFs = 0;
      this._bpF4 = 0;
      this._lastTs = 0;
      this.debug = {};
    }

    setOptions(partial) {
      Object.assign(this.opts, partial || {});
    }

    /**
     * @param {object} frame features from extractFeatures plus optional `spectrum`
     * @param {number} dtMs
     * @param {number} playbackRate  captureStream is already rate-scaled
     */
    update(frame, dtMs, playbackRate) {
      const rate = playbackRate > 0.2 ? playbackRate : 1;
      const dt = Math.max(8, Math.min(120, dtMs || 40));
      const maxHist = Math.ceil(this.opts.historyMs / dt);

      const rms = frame.rms || 0;
      this.rmsHist.push(rms);
      this.zcrHist.push(frame.zcrRate || 0);
      this.centHist.push(frame.centroid || 0);
      if (this.rmsHist.length > maxHist) {
        this.rmsHist.shift();
        this.zcrHist.shift();
        this.centHist.shift();
      }

      let flux = 0;
      if (frame.spectrum && this.prevSpec && frame.spectrum.length === this.prevSpec.length) {
        const n = frame.spectrum.length;
        for (let i = 1; i < n; i++) {
          const d = frame.spectrum[i] - this.prevSpec[i];
          if (d > 0) flux += d;
        }
      }
      if (frame.spectrum) this.prevSpec = frame.spectrum;
      this.fluxHist.push(flux);
      if (this.fluxHist.length > maxHist) this.fluxHist.shift();

      const pollHz = 1000 / dt;
      const f4 = clamp(4 * rate, 1.5, pollHz * 0.42);
      const f2 = clamp(2 * rate, 0.8, pollHz * 0.42);
      if (!this._bp4 || Math.abs(this._bpFs - pollHz) > 0.5 || Math.abs(this._bpF4 - f4) > 0.2) {
        this._bp4 = makeBandpass(pollHz, f4, 1.1);
        this._bp2 = makeBandpass(pollHz, f2, 1.0);
        this._bpFs = pollHz;
        this._bpF4 = f4;
      }
      const m4 = this._bp4(rms);
      const m2 = this._bp2(rms);

      const rmsMean = mean(this.rmsHist);
      const lowThr = Math.max(this.opts.silenceRms, rmsMean * 0.5);
      let lowCount = 0;
      for (let i = 0; i < this.rmsHist.length; i++) {
        if (this.rmsHist[i] < lowThr) lowCount++;
      }
      const lowEnergyRatio = this.rmsHist.length ? lowCount / this.rmsHist.length : 0;

      const modWin = Math.min(this.rmsHist.length, Math.ceil(1200 / dt));
      let mod4 = 0;
      let mod2 = 0;
      // Approximate modulation energy from recent bandpass outputs by
      // tracking squared output with a short EMA stored on the instance.
      this._mod4E = (this._mod4E || 0) * 0.85 + m4 * m4 * 0.15;
      this._mod2E = (this._mod2E || 0) * 0.85 + m2 * m2 * 0.15;
      const rmsEnergy = rmsMean * rmsMean + 1e-8;
      mod4 = this._mod4E / rmsEnergy;
      mod2 = this._mod2E / rmsEnergy;

      const beatPeriodicity = peakAutocorr(
        this.fluxHist,
        Math.round(pollHz * 0.28),
        Math.round(pollHz * 1.05)
      );

      const zcrVar = variance(this.zcrHist);
      const centVar = variance(this.centHist);
      const zcrVarN = clamp(zcrVar * 80, 0, 1);
      const centStable = 1 - clamp(centVar / 1.2e6, 0, 1);

      // --- scores (unbounded, then squash) ---
      let speech = 0;
      let music = 0;

      // Syllabic 4 Hz bump is the classic speech cue. Beats sit nearer 2 Hz.
      speech += 1.6 * clamp(mod4 * 18, 0, 1);
      speech += 0.7 * clamp(mod4 - mod2 * 0.7, 0, 1);
      music += 1.1 * clamp(mod2 * 14, 0, 1);

      // Talk has pauses; music is denser.
      speech += 1.35 * clamp((lowEnergyRatio - 0.18) / 0.45, 0, 1);
      music += 1.15 * clamp((0.22 - lowEnergyRatio) / 0.22, 0, 1);

      // Band layout
      speech += 1.1 * clamp((frame.speechRatio - 0.42) / 0.4, 0, 1);
      music += 1.25 * clamp(frame.bassRatio / 0.28, 0, 1);
      music += 0.45 * clamp(frame.highRatio / 0.25, 0, 1);

      // Tonal / harmonic beds (singing, chords) → music
      music += 0.9 * (1 - frame.flatness) * centStable;
      speech += 0.35 * clamp((frame.flatness - 0.25) / 0.5, 0, 1);

      // Regular onsets (kick / snare grid)
      music += 1.4 * beatPeriodicity;

      // Zero-crossing jitter is higher for consonants than sustained notes
      speech += 0.55 * zcrVarN;
      music += 0.35 * (1 - zcrVarN) * (1 - lowEnergyRatio);

      this.speechEma = this.speechEma * 0.72 + speech * 0.28;
      this.musicEma = this.musicEma * 0.72 + music * 0.28;

      const silent = rms < this.opts.silenceRms && rmsMean < this.opts.silenceRms * 1.6;
      let target;
      if (silent) {
        target = "silence";
      } else if (this.musicEma + this.opts.overlapBias >= this.speechEma) {
        target = "music";
      } else {
        target = "speech";
      }

      if (target === this.mode) {
        this.pending = null;
        this.pendingMs = 0;
        if (target === "silence") this.silenceMs += dt;
        else {
          this.silenceMs = 0;
          this.lastVoiced = target;
        }
      } else {
        if (this.pending !== target) {
          this.pending = target;
          this.pendingMs = 0;
        }
        this.pendingMs += dt;
        const hold =
          target === "silence"
            ? this.opts.silenceHoldMs
            : target === "music"
              ? this.opts.speechHoldMs
              : this.opts.musicHoldMs;
        // Entering music from speech is fast (don't speed a drop).
        // Entering speech from music is slow (don't speed a rest / vocal gap).
        const needed =
          this.mode === "speech" && target === "music"
            ? this.opts.speechHoldMs
            : this.mode === "music" && target === "speech"
              ? this.opts.musicHoldMs
              : hold;
        if (this.pendingMs >= needed) {
          this.mode = target;
          this.pending = null;
          this.pendingMs = 0;
          if (target !== "silence") this.lastVoiced = target;
        }
      }

      this.debug = {
        rms,
        speech: this.speechEma,
        music: this.musicEma,
        lowEnergyRatio,
        mod4,
        mod2,
        beatPeriodicity,
        bassRatio: frame.bassRatio,
        speechRatio: frame.speechRatio,
        flatness: frame.flatness,
        pending: this.pending,
        pendingMs: this.pendingMs,
        hist: this.rmsHist.length,
        pollHz,
        modWin,
      };

      return {
        mode: this.mode,
        lastVoiced: this.lastVoiced,
        speech: this.speechEma,
        music: this.musicEma,
        rms,
        debug: this.debug,
      };
    }
  }

  const api = {
    DEFAULTS,
    Classifier,
    extractFeatures,
    magnitudeSpectrum,
    spectrumFromDb,
    peakAutocorr,
    makeBandpass,
  };

  root.AutoScrub = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
