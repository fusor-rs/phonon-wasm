// The audio worklet that plays a synthesis while it is generated: the engine worker posts each
// frame's PCM straight here (a MessagePort the page hands to both), and the render thread plays
// the queued chunks back to back, gaplessly, from the first frame on.
//
// Messages, all tagged with the job they belong to (anything from an older job is dropped):
// `start` (a new synthesis: forget the old one), `pcm` (samples at the context's rate), `end`
// (no more samples) and `flush` (stop now). The page hears `started` (the first sample of the
// job was rendered), `underrun` (the queue ran dry before `end`), `position` (samples rendered)
// and `drained` (everything was played, or the job was flushed).

const POSITION_EVERY_QUANTA = 8;

class Playback extends AudioWorkletProcessor {
  #job = -1;
  #chunks = [];
  #offset = 0;
  #ended = true;
  #started = false;
  #starved = false;
  #rendered = 0;
  #quanta = 0;

  constructor() {
    super();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'engine') data.port.onmessage = ({ data: message }) => this.#receive(message);
      else this.#receive(data);
    };
  }

  #receive({ type, job, samples }) {
    if (type === 'start') {
      this.#reset(job);
      this.#ended = false;
      return;
    }
    if (job !== this.#job) return;
    if (type === 'pcm' && !this.#ended) this.#chunks.push(samples);
    else if (type === 'end') this.#ended = true;
    else if (type === 'flush') this.#drain();
  }

  #reset(job) {
    this.#job = job;
    this.#chunks = [];
    this.#offset = 0;
    this.#started = false;
    this.#starved = false;
    this.#rendered = 0;
  }

  #drain() {
    this.#chunks = [];
    this.#ended = true;
    this.#started = false;
    this.port.postMessage({ type: 'drained', job: this.#job, rendered: this.#rendered });
    this.#job = -1;
  }

  process(_inputs, [[out]]) {
    const written = this.#fill(out);
    this.#rendered += written;
    if (written && !this.#started) {
      this.#started = true;
      this.port.postMessage({ type: 'started', job: this.#job });
    }
    if (this.#started) this.#watch(written < out.length);
    return true;
  }

  #fill(out) {
    let written = 0;
    while (written < out.length && this.#chunks.length) {
      const chunk = this.#chunks[0];
      const count = Math.min(out.length - written, chunk.length - this.#offset);
      out.set(chunk.subarray(this.#offset, this.#offset + count), written);
      written += count;
      this.#offset += count;
      if (this.#offset === chunk.length) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    out.fill(0, written);
    return written;
  }

  #watch(short) {
    if (short && this.#ended) {
      this.#drain();
      return;
    }
    if (short && !this.#starved) this.port.postMessage({ type: 'underrun', job: this.#job });
    this.#starved = short;
    if (++this.#quanta % POSITION_EVERY_QUANTA === 0) {
      this.port.postMessage({ type: 'position', job: this.#job, rendered: this.#rendered });
    }
  }
}

registerProcessor('phonon-playback', Playback);
