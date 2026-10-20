//! The Phonon page. The form, the model's loading and each synthesis's live measurements are
//! signals here; `web/app.js` runs the engine worker and the audio, and reports back through
//! `engine` events.

mod app;
