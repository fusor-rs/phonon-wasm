use fusor::{JsInputs, Signal, signal};
use serde::{Deserialize, Serialize};

const SAMPLE_TEXT: &str = "The evening wind drifted down from the mountain pass, and the distant clouds slowly turned gold.";
const DEFAULT_TEMPERATURE: f64 = 0.3;
const DEFAULT_SEED: &str = "4242424242424242";

#[derive(Clone, PartialEq, Deserialize)]
struct Voice {
    id: String,
    // "Name — description" (`phonon::prompt::VOICES`).
    label: String,
}

impl Voice {
    fn name(&self) -> String {
        let name = self
            .label
            .split_once(" — ")
            .map_or(&*self.label, |(name, _)| name);
        name.to_string()
    }

    fn description(&self) -> String {
        let description = self.label.split_once(" — ").map_or("", |(_, rest)| rest);
        description.to_string()
    }
}

// The runtime build and the bundle, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part came from this device's storage.
    from_device: bool,
}

impl Loaded {
    fn summary(&self) -> String {
        let threads = match self.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        let source = if self.from_device {
            "model loaded from this device"
        } else {
            "model downloaded"
        };
        format!(
            "{} · {threads} · {} bundle · {source} in {}",
            self.build,
            megabytes(self.bundle_bytes),
            seconds(self.load_ms)
        )
    }
}

// One synthesis as `web/app.js` measures it, live while it runs. `heard_ms` and `wall_ms` are
// timed on the page from the click (for a queued request, from the model being ready) to the
// first sample the audio worklet rendered and to the last frame's arrival; `engine_first_ms` and
// `compute_ms` (time inside `step()`, summed) inside the engine worker.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Metrics {
    heard_ms: Option<f64>,
    engine_first_ms: Option<f64>,
    wall_ms: f64,
    compute_ms: f64,
    frames: u32,
    audio_seconds: f64,
    underruns: u32,
    requests: u32,
}

impl Metrics {
    fn heard(&self) -> String {
        self.heard_ms.map_or("–".into(), milliseconds)
    }

    fn engine_first(&self) -> String {
        self.engine_first_ms
            .map_or("waiting for the first frame".into(), |ms| {
                format!("engine {}", milliseconds(ms))
            })
    }

    fn real_time_factor(&self) -> String {
        if self.audio_seconds == 0.0 {
            return "–".into();
        }
        format!("{:.3}", self.wall_ms / 1000.0 / self.audio_seconds)
    }

    fn speedup(&self) -> String {
        if self.wall_ms == 0.0 || self.audio_seconds == 0.0 {
            return "audio seconds per wall second".into();
        }
        format!(
            "{:.1}× faster than real time",
            self.audio_seconds * 1000.0 / self.wall_ms
        )
    }

    fn per_frame(&self) -> String {
        if self.frames == 0 {
            return "–".into();
        }
        format!("{:.1} ms", self.compute_ms / f64::from(self.frames))
    }

    fn frame_budget(&self) -> String {
        if self.frames == 0 {
            return "compute per frame".into();
        }
        let budget = self.audio_seconds * 1000.0 / f64::from(self.frames);
        format!("{budget:.0} ms budget")
    }

    fn audio(&self) -> String {
        format!("{:.2} s", self.audio_seconds)
    }

    fn frames_and_underruns(&self) -> String {
        let underruns = match self.underruns {
            0 => "no gaps".to_string(),
            1 => "1 gap".to_string(),
            count => format!("{count} gaps"),
        };
        format!("{} frames · {underruns}", self.frames)
    }

    fn requests(&self) -> String {
        self.requests.to_string()
    }
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Loading {
        fraction: f64,
        detail: String,
    },
    Ready {
        voices: Vec<Voice>,
        loaded: Loaded,
    },
    Progress {
        status: String,
        metrics: Metrics,
    },
    // The audio is generated; `audio` is the WAV's blob URL.
    Done {
        status: String,
        audio: Option<String>,
        metrics: Metrics,
    },
    // New measurements after `Done` (the first sample can play after the last frame).
    Measured {
        metrics: Metrics,
    },
    // The last queued sample was played, or playback was stopped.
    Played,
    // A synthesis failed; the engine can run the next one.
    Error {
        message: String,
    },
    // The model could not load, or the engine died: nothing more can run in this page.
    Broken {
        message: String,
    },
}

// The engine's request (`phonon::session::Request` in the runtime), as `web/app.js` posts it.
#[derive(Serialize)]
struct Request {
    text: String,
    voice: String,
    temperature: f32,
    seed: u64,
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Loading,
    Ready,
    Generating,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Ready => "ready",
            Self::Generating => "generating",
            Self::Broken => "broken",
        }
    }
}

#[derive(JsInputs)]
struct App {
    text: Signal<String>,
    voice: Signal<String>,
    temperature: Signal<f64>,
    seed: Signal<String>,
    // `web/app.js` acts on every new count: `clicks` (Speak) resumes the audio
    // output inside the user's gesture, `starts` runs `request`, `stops` stops the synthesis and
    // the playback.
    #[js]
    request: Signal<String>,
    #[js]
    clicks: Signal<u32>,
    #[js]
    starts: Signal<u32>,
    #[js]
    stops: Signal<u32>,
    phase: Signal<Phase>,
    // Speak was clicked while the model loaded: it runs as soon as the model is ready.
    queued: Signal<bool>,
    playing: Signal<bool>,
    fraction: Signal<f64>,
    detail: Signal<String>,
    voices: Signal<Vec<Voice>>,
    status: Signal<String>,
    audio: Signal<Option<String>>,
    metrics: Signal<Metrics>,
    measured: Signal<bool>,
    loaded: Signal<Option<Loaded>>,
}

impl App {
    fn new() -> Self {
        Self {
            text: signal(SAMPLE_TEXT.into()),
            voice: signal(String::new()),
            temperature: signal(DEFAULT_TEMPERATURE),
            seed: signal(DEFAULT_SEED.into()),
            request: signal(String::new()),
            clicks: signal(0),
            starts: signal(0),
            stops: signal(0),
            phase: signal(Phase::Loading),
            queued: signal(false),
            playing: signal(false),
            fraction: signal(0.0),
            detail: signal("Starting…".into()),
            voices: signal(Vec::new()),
            status: signal(String::new()),
            audio: signal(None),
            metrics: signal(Metrics::default()),
            measured: signal(false),
            loaded: signal(None),
        }
    }

    fn generate(&self) {
        self.clicks.update(|count| *count += 1);
        let Some(request) = self.request(&self.text.get(), self.voice.get()) else {
            return;
        };
        if self.phase.get() == Phase::Loading {
            self.queued.set(true);
            self.status
                .set("Queued: it speaks the moment the model is ready.".into());
        } else {
            self.begin(request);
        }
    }

    // The engine request for `text` in `voice` with the form's settings, as JSON, or `None` after
    // telling what is wrong.
    fn request(&self, text: &str, voice: String) -> Option<String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            self.status.set("Type some text first.".into());
            return None;
        }
        let Ok(seed) = self.seed.get().trim().parse::<u64>() else {
            self.status
                .set("The seed is a whole number from 0 to 18446744073709551615.".into());
            return None;
        };
        let request = Request {
            text,
            voice,
            temperature: self.temperature.get() as f32,
            seed,
        };
        Some(serde_json::to_string(&request).expect("plain data serializes"))
    }

    fn begin(&self, request: String) {
        self.request.set(request);
        self.phase.set(Phase::Generating);
        self.playing.set(true);
        self.measured.set(true);
        self.metrics.set(Metrics::default());
        self.status.set("Preparing…".into());
        self.starts.update(|count| *count += 1);
    }

    fn stop(&self) {
        if self.queued.get() {
            self.queued.set(false);
            self.status.set("Cancelled.".into());
            return;
        }
        self.stops.update(|count| *count += 1);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Loading { fraction, detail } => {
                self.fraction.set(fraction);
                self.detail.set(detail);
            }
            Report::Ready { voices, loaded } => self.ready(voices, loaded),
            Report::Progress { status, metrics } => {
                self.status.set(status);
                self.metrics.set(metrics);
            }
            Report::Done {
                status,
                audio,
                metrics,
            } => {
                self.status.set(status);
                self.audio.set(audio);
                self.metrics.set(metrics);
                self.phase.set(Phase::Ready);
            }
            Report::Measured { metrics } => self.metrics.set(metrics),
            Report::Played => self.playing.set(false),
            Report::Error { message } => {
                self.status.set(format!("error: {message}"));
                self.playing.set(false);
                self.phase.set(Phase::Ready);
            }
            Report::Broken { message } => {
                self.detail.set(message);
                self.phase.set(Phase::Broken);
            }
        }
    }

    fn ready(&self, voices: Vec<Voice>, loaded: Loaded) {
        if let Some(first) = voices.first() {
            self.voice.set(first.id.clone());
        }
        self.voices.set(voices);
        self.loaded.set(Some(loaded));
        self.phase.set(Phase::Ready);
        let queued = self.queued.get();
        self.queued.set(false);
        if queued && let Some(request) = self.request(&self.text.get(), self.voice.get()) {
            self.begin(request);
        }
    }

    fn summary(&self) -> String {
        self.loaded
            .get()
            .map_or(String::new(), |loaded| loaded.summary())
    }

    fn generate_label(&self) -> &'static str {
        match (self.phase.get(), self.queued.get()) {
            (Phase::Loading, true) => "Queued",
            (Phase::Loading, false) => "Speak when ready",
            _ => "Speak",
        }
    }

    fn can_stop(&self) -> bool {
        self.phase.get() == Phase::Generating || self.playing.get() || self.queued.get()
    }

    // The model never loaded: likely a bundle that does not match the runtime.
    fn failed_to_load(&self) -> bool {
        self.loaded.get().is_none()
    }

    fn can_generate(&self) -> bool {
        match self.phase.get() {
            Phase::Loading => !self.queued.get(),
            Phase::Ready => true,
            Phase::Generating | Phase::Broken => false,
        }
    }
}

fn milliseconds(ms: f64) -> String {
    format!("{ms:.0} ms")
}

fn seconds(ms: f64) -> String {
    format!("{:.1} s", ms / 1000.0)
}

fn megabytes(bytes: f64) -> String {
    format!("{:.1} MB", bytes / 1e6)
}

fusor::template!("web/index.html");
