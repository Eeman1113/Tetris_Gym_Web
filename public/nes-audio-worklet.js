// Ring buffer fed from the main thread, drained by the audio device.
const CAPACITY = 16384; // ~340ms at 48kHz, power of two for cheap wrapping
const MASK = CAPACITY - 1;

class NESAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = new Float32Array(CAPACITY);
    this.bufR = new Float32Array(CAPACITY);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.tick = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === "samples") {
        const { left, right } = d;
        const n = left.length;
        if (this.count + n > CAPACITY) {
          const drop = this.count + n - CAPACITY;
          this.read = (this.read + drop) & MASK;
          this.count -= drop;
        }
        let w = this.write;
        for (let i = 0; i < n; i++) {
          this.bufL[w] = left[i];
          this.bufR[w] = right[i];
          w = (w + 1) & MASK;
        }
        this.write = w;
        this.count += n;
      } else if (d.type === "reset") {
        this.read = this.write = this.count = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const size = outL.length;
    let r = this.read;

    if (this.count >= size) {
      for (let i = 0; i < size; i++) {
        outL[i] = this.bufL[r];
        outR[i] = this.bufR[r];
        r = (r + 1) & MASK;
      }
      this.count -= size;
    } else {
      // Underrun: play what we have, then hold the last value. A DC hold is
      // far less audible than a hard jump to zero, which clicks.
      const avail = this.count;
      for (let i = 0; i < avail; i++) {
        outL[i] = this.bufL[r];
        outR[i] = this.bufR[r];
        r = (r + 1) & MASK;
      }
      const hl = avail > 0 ? outL[avail - 1] : this.lastL;
      const hr = avail > 0 ? outR[avail - 1] : this.lastR;
      for (let i = avail; i < size; i++) {
        outL[i] = hl;
        outR[i] = hr;
      }
      this.count = 0;
    }

    this.read = r;
    this.lastL = outL[size - 1];
    this.lastR = outR[size - 1];

    // Report queue depth so the main thread can pace emulation off the audio
    // clock. Throttled: process() runs every ~2.7ms, this reports every ~21ms.
    if ((this.tick++ & 7) === 0) {
      this.port.postMessage({ type: "depth", count: this.count });
    }
    return true;
  }
}

registerProcessor("nes-audio-processor", NESAudioProcessor);
