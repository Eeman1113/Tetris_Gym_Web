import { NES } from "jsnes";

const W = 256;
const H = 240;

// NTSC NES frame rate: 1789773 * 3 / (341 * 262 - 0.5). Not 60.
const NES_FPS = 60.0988;
const FRAME_MS = 1000 / NES_FPS;

// Matches the AudioWorklet render quantum, so one flush is one quantum.
const BATCH = 128;
const MAX_CATCHUP = 4;

/**
 * Boots the emulator onto a canvas and runs it.
 *
 * Timing is a hybrid: requestAnimationFrame paces the loop and does all the
 * presenting, but the audio device is the authoritative clock. rAF ticks at
 * the display rate (60, 120, 144...), never at the NES' 60.0988, so running
 * exactly one frame per rAF drifts several frames a minute and the audio
 * buffer slowly drains or overflows. Instead we accumulate real elapsed time
 * to decide how many frames to run, then nudge that by one based on how much
 * audio is actually queued — the sound card pulls at a true constant rate, so
 * steering by buffer depth removes the drift for free.
 */
export async function createNes(canvas, rom, opts = {}) {
  // ---------------------------------------------------------------- canvas
  canvas.width = W;
  canvas.height = H;
  // alpha:false lets the compositor skip blending the canvas over the page.
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  ctx.imageSmoothingEnabled = false;

  const imageData = ctx.createImageData(W, H);
  // One buffer, two views: fill as 32-bit words, hand to ImageData as bytes.
  const ab = new ArrayBuffer(W * H * 4);
  const buf32 = new Uint32Array(ab);
  const buf8 = new Uint8ClampedArray(ab);
  buf32.fill(0xff000000); // opaque black — alpha is written once, never again

  let dirty = false;

  // jsnes hands back its live ppu.buffer and overwrites it next frame, so it
  // must be consumed synchronously here rather than stashed for later.
  //
  // Pixels arrive as 0x00BBGGRR; canvas ImageData read as Uint32 on a
  // little-endian host is 0xAABBGGRR, so the colour channels already line up
  // and only alpha needs OR-ing in. No byte swapping.
  const onFrame = (fb) => {
    for (let i = 0; i < W * H; i++) buf32[i] = 0xff000000 | fb[i];
    dirty = true;
  };

  const present = () => {
    if (!dirty) return;
    imageData.data.set(buf8);
    ctx.putImageData(imageData, 0, 0);
    dirty = false;
  };

  // ----------------------------------------------------------------- audio
  let audioCtx = null;
  let node = null;
  const batchL = new Float32Array(BATCH);
  const batchR = new Float32Array(BATCH);
  let batchPos = 0;
  let depth = 0; // samples queued in the worklet, as last reported
  let targetDepth = 2400;
  // Browsers start the audio device suspended until a user gesture. Until it
  // is genuinely running it pulls nothing, so its queue depth says nothing
  // about real time and must not be allowed to steer the frame pacing.
  let audioRunning = false;
  let onAudioStateChange = null;

  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (AC) {
    try {
      // Build the context first, then generate at exactly the device rate.
      // That removes resampling entirely: jsnes derives its APU sample timer
      // from sampleRate, so asking for the device's own rate means every
      // sample it emits is consumed 1:1. (jsnes' own Browser wrapper reads the
      // rate before the context exists, gets a hardcoded 44100, and so runs
      // the APU 8.8% slow on the very common 48kHz device.)
      audioCtx = new AC({ latencyHint: "interactive" });
      await audioCtx.audioWorklet.addModule(opts.workletUrl ?? "/nes-audio-worklet.js");
      node = new AudioWorkletNode(audioCtx, "nes-audio-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.port.onmessage = (e) => {
        if (e.data.type === "depth") depth = e.data.count;
      };
      node.connect(audioCtx.destination);
      const ctx = audioCtx; // captured: destroy() clears the outer binding
      audioRunning = ctx.state === "running";
      onAudioStateChange = () => {
        audioRunning = ctx.state === "running";
        if (!audioRunning) return;
        depth = 0; // whatever was queued went stale while suspended
        node?.port.postMessage({ type: "reset" });
      };
      ctx.addEventListener("statechange", onAudioStateChange);
      // ~3 frames of slack: enough to ride out a slow frame, short enough that
      // input-to-sound latency stays imperceptible.
      targetDepth = Math.round((audioCtx.sampleRate / NES_FPS) * 3);
    } catch {
      audioCtx = null;
      node = null; // the picture still runs; only sound is lost
    }
  }

  const sampleRate = audioCtx ? audioCtx.sampleRate : 48000;

  const flush = () => {
    if (batchPos === 0 || !node) return;
    if (!audioRunning) {
      // Nothing is draining the queue yet; drop rather than fill it with
      // samples that would play as a burst of stale audio on unlock.
      batchPos = 0;
      return;
    }
    node.port.postMessage({
      type: "samples",
      left: batchL.slice(0, batchPos),
      right: batchR.slice(0, batchPos),
    });
    depth += batchPos; // optimistic, corrected by the worklet's depth reports
    batchPos = 0;
  };

  // Called ~800 times a frame, so it stays allocation free.
  const onAudioSample = (l, r) => {
    if (!node) return;
    batchL[batchPos] = l;
    batchR[batchPos] = r;
    if (++batchPos >= BATCH) flush();
  };

  // ------------------------------------------------------------------- nes
  const nes = new NES({
    onFrame,
    onAudioSample,
    emulateSound: true,
    sampleRate,
    onStatusUpdate: () => {},
  });

  nes.loadROM(rom); // jsnes 2.x takes a Uint8Array directly

  // jsnes' default 8px edge clipping stays on: those columns hold scroll
  // garbage that a real NES hid in TV overscan, and showing them looks broken.
  // Nothing of the playfield lives there.

  // ------------------------------------------------------------------ loop
  let running = false;
  let rafId = 0;
  let lastTime = 0;
  let accumulator = 0;
  let hiddenTimer = 0;

  const runFrame = () => {
    try {
      nes.frame();
    } catch (e) {
      stop();
      opts.onError?.(e);
      return;
    }
    flush(); // push the tail batch so audio never trails a frame behind
  };

  const tick = (now) => {
    if (!running) return;
    rafId = requestAnimationFrame(tick);

    if (lastTime === 0) {
      lastTime = now;
      return;
    }
    let dt = now - lastTime;
    lastTime = now;
    // Coming back from a stall (tab restore, GC pause): take one frame rather
    // than replaying the whole gap in a burst.
    if (dt > 250) dt = FRAME_MS;

    accumulator += dt;
    const whole = Math.floor(accumulator / FRAME_MS);
    accumulator -= whole * FRAME_MS;

    let n = whole;
    if (audioRunning) {
      if (depth < targetDepth * 0.5) n += 1;
      else if (depth > targetDepth * 2) n -= 1;
    }
    if (n > MAX_CATCHUP) n = MAX_CATCHUP;

    for (let i = 0; i < n; i++) runFrame();
    present(); // once per rAF, however many frames ran
  };

  // rAF stops while the tab is hidden but the AudioContext keeps pulling, so a
  // pure-rAF loop would starve into a buzz. Fall back to a timer that only
  // runs frames while the buffer is short — that keeps sound alive and
  // self-throttles if the timer gets clamped.
  const onVisibility = () => {
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      if (running && audioRunning && !hiddenTimer) {
        hiddenTimer = setInterval(() => {
          for (let i = 0; i < MAX_CATCHUP && depth < targetDepth; i++) runFrame();
        }, 16);
      }
    } else {
      if (hiddenTimer) {
        clearInterval(hiddenTimer);
        hiddenTimer = 0;
      }
      lastTime = 0;
      accumulator = 0; // drop the backlog instead of fast-forwarding
      if (running && !rafId) rafId = requestAnimationFrame(tick);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (hiddenTimer) {
      clearInterval(hiddenTimer);
      hiddenTimer = 0;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      lastTime = 0;
      accumulator = 0;
      if (document.hidden) onVisibility();
      else rafId = requestAnimationFrame(tick);
    },
    stop,
    destroy() {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      if (onAudioStateChange) audioCtx?.removeEventListener("statechange", onAudioStateChange);
      onAudioStateChange = null;
      node?.disconnect();
      node = null;
      audioCtx?.close().catch(() => {});
      audioCtx = null;
    },
    // Drops straight into createPad({ down, up }).
    down: (b) => nes.buttonDown(1, b),
    up: (b) => nes.buttonUp(1, b),
    /** Browsers only allow this from inside a real user gesture. */
    unlockAudio() {
      if (audioCtx && audioCtx.state !== "running") audioCtx.resume().catch(() => {});
    },
    get audioRunning() {
      return audioRunning;
    },
  };
}
