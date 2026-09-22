# Fly DJ

**[Try it → squidish.github.io/fruitfly-dj](https://squidish.github.io/fruitfly-dj/)**
— works on a phone; tap "Wake the fly" to start.

A browser app that plays EDM to a connectome-based model of the fruit fly's
auditory pathway, visualises the neural response live, and shows a cartoon fly
dancing as much as its brain allows.

**The joke.** Fly hearing is tuned to courtship song: roughly 250 Hz tone
pulses about 35 ms apart, delivered in short trains. EDM is neither. The fly
cannot hear your hi-hats and is unmoved by four-on-the-floor. The app shows
*why*, and lets you resize the fly until it gets into it.

Everything runs client-side. No backend, no accounts, no analytics, and at
runtime no network requests beyond the app's own assets.

## Quick start

```bash
npm i
npm run dev
```

Works out of the box with zero external assets: a committed toy circuit and a
licence-free generator. Click **Wake the fly** (browsers will not start audio
without a gesture) and you are running.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Licence check, typecheck, production build |
| `npm test` | Vitest — core DSP, model, and the §13 acceptance criteria |
| `npm run bench` | Model report: tuning curve, approval table, ablation, performance |
| `npm run tune` | Re-fit the model defaults into `src/state/tuned.json` |
| `npm run smoke` | Drives the built app in headless Chromium |
| `npm run toy` | Regenerate the toy circuit |
| `npm run check-tracks` | Fail if any bundled audio lacks an allowed licence |

### Things to actually try

1. Start on **Four on the Floor 128**. The fly ignores it completely — approval
   sits at zero and the status line says so.
2. Switch to **Courtship Riddim**. Approval jumps past 1.0, the wings come out,
   and the raster fills with clean pulse trains.
3. Switch to **Bass Rolls** and turn on **Auto-fit**. The fly resizes itself to
   about 3.35× — a 16th note at 128 BPM is 117 ms, which is 3.35 courtship
   inter-pulse intervals — and starts to care.
4. Press **Compare wirings**. The last 10 seconds are re-run through the real
   wiring, a degree-preserving shuffle, and sensors-wired-straight-to-song. The
   panel says what it found, including when the answer is unflattering.
5. Open **About** for the full list of modelling assumptions.

## How it works

```
Audio source ─► fly-voice mixer ─► master bus ─► speakers
                                        │ (tap excludes the fly's own voice)
                                        ▼
                              EarWorklet (AudioWorklet)
                              band-pass → envelope → decimate to 2 kHz
                              full-band onset detector (5 ms hop)
                                        │ MessagePort, bypassing the main thread
                                        ▼
                              BrainWorker (Web Worker)
                              JO drive → LIF + STP → spikes, rates, approval
                                        │
                                        ▼
                              Main thread renders events up to
                              ctx.getOutputTimestamp().contextTime
```

**`src/core/` is pure TypeScript** — no DOM, no Web Audio. The AudioWorklet,
the worker, the Node bench and the tests all import the identical code, which
is why a bench number and what you hear in the browser describe the same model.

**AudioContext time is the master clock.** Spikes are stamped in context time
and the renderer draws only up to `getOutputTimestamp().contextTime`, so the
raster lines up with what reaches the speakers even over Bluetooth.

**Two layers, labelled honestly.** The ear is phenomenological and invented.
The brain is leaky integrate-and-fire on connectome topology. The one temporal
assumption — Tsodyks–Markram short-term plasticity on the edges into the song
group — is isolated so that the ablation modes can test how much of the result
is wiring and how much is that assumption plus the ear.

Every assumption that did not come from the connectome is in
[`src/core/ASSUMPTIONS.md`](src/core/ASSUMPTIONS.md), which the About panel
renders directly so the two cannot drift apart.

### What the model is and is not

It is **not a validated model of anything**. It is a simplified simulation in
the spirit of Shiu et al. (*Nature*, 2024), built to be looked at rather than
believed. The dance is an artistic mapping of network activity, not simulated
motor behaviour.

Two honest results worth knowing before you draw conclusions from it:

- On the toy circuit, Connectome beats Shuffled **by construction**. That makes
  the Compare panel a check on the ablation machinery, not evidence about
  flies. On real data, "the wiring barely matters" is a legitimate outcome, and
  the panel will say so.
- Approval divides the song group's rate by the sensors' rate, which is what
  makes it robust to volume. It also means approval mildly *penalises* the
  conditions where the ear is best matched to the signal, because the sensor
  rate rises too. Auto-fit still lands on the size where the song group
  responds most; the approval number just does not rise as steeply as you might
  expect.

## Real connectome data

The app ships with a synthetic toy circuit. To run it on real data, export the
tables yourself from [FlyWire Codex](https://codex.flywire.ai/) (free account,
confirm the licence — expected CC-BY 4.0) and run:

```bash
python3 tools/extract_circuit.py --codex ~/Downloads/flywire --out public/data
```

The loader prefers `circuit.*` over `toy_circuit.*`, and the header badge tells
you which is live. See [`tools/README.md`](tools/README.md) for the details,
including which cell types to check and why root IDs must never go near a
float.

Cite Dorkenwald et al. (2024) and Schlegel et al. (2024). Both citations are
written into the generated metadata and shown in About.

## Music

The generator is licence-free and needs no assets. To bundle tracks, put them
in `public/audio/` and add entries to `public/audio/tracks.json`;
`npm run check-tracks` runs before every build and fails on anything without an
allowed licence. See [TRACKS.md](TRACKS.md).

Dropped files and microphone input are decoded locally and never uploaded. The
microphone is captured with `echoCancellation`, `noiseSuppression` and
`autoGainControl` all off — those three chew up exactly the onsets the model is
looking for — and is routed to the ear but never to the speakers.

## Safety and accessibility

- **Photosensitivity.** Pulse song at ~28 Hz driven onto the visuals would be a
  seizure risk. A core flash limiter caps any element larger than 2% of the
  viewport at 3 flashes per second, where a flash is a pair of opposing
  luminance changes. Per-spike effects are allowed only on small elements such
  as raster dots. The limiter is unit-tested.
- **Motion.** `prefers-reduced-motion` damps every animation amplitude and
  disables the breakout flight loop.
- **The fly is bipedal on purpose.** It stands upright and dances like a
  person, which no fly does. Bipedal reads as dancing; six-legged reads as
  scuttling. Noted in `ASSUMPTIONS.md` along with everything else invented.
- **Access.** All controls are keyboard operable and labelled, focus is always
  visible, and light and dark themes follow `prefers-color-scheme`.
- **Loudness.** The generator starts quiet and the fly's own voice is
  hard-capped.

## Deploying

Static hosting, nothing else required. `.github/workflows/pages.yml` runs the
tests and publishes to GitHub Pages on every push to `main`.

For any other host, build with the subpath it will be served from:

```bash
BASE_PATH=/your-repo/ npm run build
```

`BASE_PATH` is the only thing in the project that knows about hosting.

`SharedArrayBuffer` is deliberately not used anywhere, because it needs
COOP/COEP headers that plain static hosting cannot set.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Silence on iPhone | **Check the hardware silent switch first** — it mutes Web Audio. The app handles the `interrupted` context state and resumes on `visibilitychange`, but it cannot override the switch. |
| Visuals ahead of the sound | They should not be — the renderer follows the output timestamp. If they are, check the behaviour line under the fly; it reports measured audio latency. |
| "brain lag" badge | The worker fell behind and coarsened its own timestep to 1 ms × k. Audio never stalls; the simulation just gets less precise. |
| Approval stuck at zero | Probably correct. Check the **What you hear vs what the fly hears** panel: if the envelope trace is flat, there is nothing in the fly's band. |
| The fly will not stop grooming | Too much sub-bass. The deflection channel drives the grooming pathway, and grooming overrides dancing. |

## Project layout

```
src/
  core/     ear, LIF, CSR, STP, approval, flash limiter, RNG, sim, ASSUMPTIONS.md
  audio/    engine, Tone.js generator, EarWorklet, fly voice, patterns, messages
  brain/    worker, loader, calibration, ablation
  viz/      hear panel, raster, graph, IPI plot, compare, 3D cloud, theme
  fly/      fly.svg, rig, behaviours
  state/    params schema, URL state, tuned.json
  ui/       controls, copy, about, start gate
tools/      toy circuit generator, connectome extractor, config
scripts/    bench, tune, check-tracks, browser smoke test
tests/      core DSP, model, acceptance criteria
```

### Deviations from the build spec

Three, all deliberate, all for reasons the code comments spell out:

1. **The ear cascades two band-pass sections** instead of one. A single
   2nd-order section at Q = 2 leaves a hi-hat only ~36 dB down, which leaks
   through the sensors' threshold nonlinearity and undermines the premise.
2. **An auditory gain control was added.** Without it the volume-invariance
   criterion cannot be met at all: the cascade is threshold-nonlinear, so
   halving the level silences the song group outright. It follows broadband
   peak level, never fly-band energy or RMS — both alternatives break something
   else. It can be switched off under Advanced.
3. **The 3D soma cloud is raw WebGL, not three.js.** It is one buffer of points
   and an orbit matrix; a scene graph would cost more download than the rest of
   the app put together.

The volume-invariance acceptance criterion is tested by scaling the **input
signal** 0.5–2×, which is what "volume invariance" means. The Sensitivity
control is the fly's own gain and is deliberately *not* compensated — being
able to change it is the whole point of the knob.

## Open questions for the owner

- Vanilla TypeScript is assumed and used. The control panel is generated from a
  schema, so no framework was needed.
- GitHub Pages is assumed as the hosting target (`BASE_PATH` handles the
  subpath).
- MaleCNS access route is unconfirmed and not required for v1.
- Art direction went cartoon-cute rather than scientific-illustration. The fly
  is original and deliberately resembles no existing mascot.

## Licence

Code: MIT. The toy circuit is synthetic and carries no third-party rights.
Anything you extract from FlyWire carries FlyWire's licence — check it.
