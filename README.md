# Auto Scrub Speed

Chrome extension that listens to whatever is playing in a page’s `<video>` (or `<audio>`) element and sets playback speed from the audio itself:

| What’s playing | Speed (default) |
| --- | --- |
| Talking / narration | **1.5×** |
| Music, singing, or a beat | **1.0×** |

Detection is on-device via the Web Audio API. Nothing is recorded or sent anywhere.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** and select this folder
4. Open a video (YouTube, a course site, this repo’s demo page) and press play
5. Pin the extension to tweak speeds or turn it off

Keyboard toggle: `Alt+Shift+S`

## How it decides

Every ~40 ms the content script taps the media element with `captureStream()` (playback itself is not rerouted) and scores the frame:

- **Talking:** 4 Hz syllabic envelope, pauses between phrases, energy concentrated in the speech band
- **Music:** bass + harmonic stack, regular onsets (a beat), more continuous energy
- **Overlap:** a music bed under talking counts as music, so a song does not get sped up. The popup slider *When both overlap, prefer* changes that bias.

Speed changes are held for a few hundred milliseconds so a rest in a song does not flip to 1.5×, and ramped so the jump is not a click.

## Demo

From this repo:

```bash
python3 -m http.server 8765
```

Open http://localhost:8765/demo/ and click **Talking** then **Music**. The on-page meter uses the same classifier as the extension. With the extension loaded you should also see the overlay on the video switch between 1.50× and 1.00×.

Classifier unit tests (no browser):

```bash
node tests/classifier.test.js
```

## Limits

- **DRM** (Netflix, Disney+, some Prime titles): `captureStream()` is blocked, so the extension cannot hear the audio.
- **Heavy background music under speech:** may stay at 1×. Turn *prefer* toward talking if you watch vlogs with a constant bed.
- **Cross-origin media** that never plays through a real media element cannot be analysed.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | Manifest V3 |
| `classifier.js` | Speech / music scorer |
| `content.js` | Finds media, captures audio, sets `playbackRate`, overlay |
| `background.js` | Badge + keyboard toggle |
| `popup.html` | Settings |
