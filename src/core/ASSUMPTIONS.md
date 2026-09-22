# Modelling assumptions

Hard rule 5: every modelling assumption that did **not** come from the
connectome is listed here, and this file is what the About panel renders.

A connectome gives you wiring and synapse counts. It does not give you
dynamics, transmitter time courses, adaptation, or anything about the ear.
Everything in that gap is a choice, and all of those choices are below.

## The ear is entirely phenomenological

Nothing in the ear model comes from connectome data. It is a filter bank
chosen to behave roughly like Johnston's organ, not a model of it.

- **Band-pass at `f_c` (default 250 Hz).** Real *Drosophila* antennal hearing
  is tuned near the carrier of courtship song. The number is right; the filter
  shape is invented.
- **Two cascaded 2nd-order sections per channel, Q = 2.** The spec called for
  a single band-pass at Q ≈ 2. One section rolls off at only 6 dB/octave, which
  leaves a hi-hat about 36 dB down — enough to leak through the sensors'
  threshold nonlinearity and quietly undermine the whole premise. Two sections
  give 12 dB/octave. Real JO tuning is sharper still.
- **Full-wave rectification and a one-pole envelope, `τ_env` ≈ 3 ms.** A
  stand-in for transduction and adaptation, with no mechanistic content.
- **Per-neuron `f_c` jitter of ±20%**, implemented as a bank of 8 channels
  spanning that range, with each sensory neuron assigned to one channel by a
  seeded draw. Real JO neurons are heterogeneous; this shape of heterogeneity
  is invented.
- **Decimation to 2 kHz.** An engineering choice. It is comfortably above the
  envelope bandwidth the model cares about.
- **The deflection channel (JO-C/E) is driven by energy below `f_c / 6`.**
  Mapping sub-bass onto the deflection-sensitive classes is **artistic
  licence**. Real JO-C/E respond to sustained antennal displacement — wind,
  gravity, static deflection — not to the low end of a kick drum.

## Auditory gain control

**Not in the spec, and not from the connectome.** The ear applies a
peak-following automatic gain control before the sensors.

Without it the model fails its own volume-invariance criterion, and not
subtly: the cascade is threshold-nonlinear, so halving the input level
silences the song group outright and approval drops to zero. Real auditory
peripheries adapt to overall sound level, so an AGC is the honest fix rather
than a fudge — but it is still an addition.

Two properties of it matter, and both were arrived at by watching it go wrong:

- It follows **broadband** input, never fly-band energy. A band-driven AGC
  would crank its gain up on a track with nothing in the band, and the fly
  would start hearing hi-hats. That would destroy the premise.
- It follows **peak** level, not RMS. An RMS follower also tracks duty cycle,
  so a sparse pulse train reads as "quiet" and gets boosted — which lifts the
  long-IPI end of the tuning curve and flattens the very selectivity the model
  exists to demonstrate.

It can be switched off under Advanced. Do that and the volume knob buys
affection again, which is itself worth seeing once.

## The brain: LIF on connectome topology

- **Leaky integrate-and-fire neurons.** Real neurons are not.
- **Weight = synapse count × sign × `w_scale`**, with `inhib_scale` applied to
  negative weights. Synapse count is a proxy for strength. It is a defensible
  proxy and it is not a measurement.
- **Sign from neurotransmitter: ACh = +1, GABA = −1, Glu = −1**, following the
  convention in Shiu et al. (Nature, 2024). Other transmitters get 0 and are
  logged by the extraction script. Glutamate is not always inhibitory in the
  fly.
- **Delta-function synapses with one uniform delay (1.8 ms).** No synaptic time
  course, no per-connection conduction delays, no dendritic anything.
- **Normalised units:** rest = 0, threshold = 1. So a weight is literally the
  fraction of threshold one presynaptic spike contributes.
- **Membrane noise** is Gaussian, drawn from the seeded generator so that the
  same seed and the same input give identical spikes.
- **No spike-frequency adaptation, no neuromodulation, no plasticity beyond
  the short-term dynamics below.**

## Short-term plasticity is *the* temporal assumption

Tsodyks–Markram short-term plasticity on the edges **into the song group
only**, with parameters `U`, `τ_fac` and `τ_rec`.

This is the only place the target inter-pulse interval enters the model, and
it is deliberately isolated so that it can be argued with.

A connectome constrains wiring, not dynamics. Nothing guarantees that IPI
selectivity emerges from topology alone, and in this model it does not: the
band-pass in IPI comes from here. Short intervals arrive before vesicles have
recovered and depress; long intervals arrive after facilitation has decayed.
Both ends fall away, leaving a peak in between, which `npm run tune` fits to
the target IPI.

Release gain is **normalised by `U`**, so an isolated spike after a long
silence returns exactly 1.0. That keeps `w_scale` meaning the same thing with
plasticity on or off.

The Ablation modes exist to test how much of the result is wiring and how much
is this assumption plus the ear. On real data, "the wiring barely matters" is
an acceptable answer.

## The toy circuit

The committed toy circuit is **synthetic**. It is not a model of any animal.

Cell type names (JO-A, AMMC-B1, pC2l, …) echo the real auditory pathway for
legibility only; no FlyWire root ID appears anywhere in it.

It is built so the Connectome mode beats Shuffled **by construction**, which
makes it a sanity check on the ablation machinery rather than evidence about
flies. Its local interneurons are driven by their own layer's projection
neurons, so inhibition lands one synaptic delay after the excitation it
follows and trims a burst to roughly one spike per pulse — without that, the
synapses downstream see bursts instead of intervals and the IPI code never
reaches the song group at all.

## Fly size

"Fly size" `k` multiplies every time constant by `k` and divides `f_c` by `k`.
Real flies do not scale that way, and a fly 3.3× larger would not hear at
76 Hz. It is a legible way to move the model's temporal window onto the
music's, and it is causal and real-time, which the v1 approach of
time-compressing the input was not.

## Approval

Approval is a selectivity index, not a firing rate:

    S = r_song / max(r_sensor, r_floor)
    A = (S − S_noise) / (S_ideal − S_noise)

`S_ideal` is measured on ideal pulse song at the target IPI; `S_noise` on the
same carrier amplitude-modulated by a **noise envelope** of comparable
bandwidth. Matching spectrum as well as energy matters: broadband noise scaled
to match fly-band energy ends up enormously loud out of band and measures the
deflection channel instead.

That the song group's rate is divided by the sensors' rate is itself a
modelling choice. It makes approval robust to level, and it makes approval
mildly *penalise* the conditions where the ear is best matched to the signal,
because sensor rate rises too.

## The dance

The dance is an **artistic mapping** of network activity onto a rig. It is not
simulated motor behaviour, and none of it is derived from the connectome.

- **The fly dances upright, on two legs, with four arms.** Real flies do not
  stand bipedally, and nothing about this posture is defensible. It is a
  legibility choice: bipedal reads as *dancing* at a glance, where six-legged
  reads as scuttling. The six limbs are still all there, just reassigned.
- Body bob follows fly-band envelope peaks, not the kick. That mismatch is
  intentional and is the most visible part of the joke.
- Hip sway runs on a free oscillator rather than on the beat. Driving the sway
  and the bob from the same signal reads as a twitch; letting the sway drift
  underneath the bob reads as keeping time.
- Male unilateral wing extension is real courtship behaviour, rendered
  cartoonishly.
- The **female wing shimmer is invented.** Females do not sing. It exists so
  the female has a courtship-state vocabulary at all.
- Antennal grooming triggered by the grooming pathway's firing rate is a
  plausible-looking mapping, not a model of grooming.
