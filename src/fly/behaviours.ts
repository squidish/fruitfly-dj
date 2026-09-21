/**
 * The fly's behaviour state machine.
 *
 * This is an artistic mapping of network activity onto a rig, not simulated
 * motor behaviour, and the About panel says so. What it does take seriously is
 * consistency: FAFB is a female brain and females do not sing, so the dance
 * vocabulary differs by sex and the male's sing-back is opt-in.
 *
 * The body bobs to fly-band envelope peaks, NOT to the kick. That distinction
 * is the entire point: when four-on-the-floor is playing, the fly is visibly
 * out of time with the music, because it cannot hear the part you are hearing.
 */

import { neutralPose, type Pose } from './rig.ts';

export type FlyState = 'idle' | 'dancing' | 'courting' | 'grooming' | 'breakout';

export interface FlySignals {
  approval: number;
  /** Sensory (Johnston's organ) rate in Hz. */
  joRate: number;
  /** Mean relay rate in Hz. */
  relayRate: number;
  /** Grooming-pathway rate in Hz. */
  groomRate: number;
  groomThreshold: number;
  /** True on frames where a fly-band envelope peak has just been heard. */
  envPeak: boolean;
  sex: 'male' | 'female';
  /** Fly size: a bigger fly moves more slowly. */
  k: number;
  reducedMotion: boolean;
}

/** Approval bands the behaviour switches on. */
const IDLE_BELOW = 0.1;
const COURT_ABOVE = 0.6;
const BREAKOUT_ABOVE = 1.2;
const BREAKOUT_HOLD = 8;
const GROOM_HOLD = 1;
const GROOM_COOLDOWN = 3;

export class FlyBehaviour {
  state: FlyState = 'idle';
  private pose = neutralPose();
  private time = 0;
  private legPhase = 0;
  private bobEnergy = 0;
  private antennaEnergy = 0;
  private groomTimer = 0;
  private groomCooldown = 0;
  private groomBlend = 0;
  private breakoutTimer = 0;
  private breakoutProgress = 0;
  private wingSide = 1;
  private wingTimer = 0;
  private wander = 0;
  private wanderTarget = 0;
  private facing = 1;

  /** True while a male should be singing back, if the user allowed it. */
  get wantsToSing(): boolean {
    return this.state === 'courting' && this.pose.wingLeft + this.pose.wingRight !== 0;
  }

  update(dt: number, s: FlySignals): Pose {
    // A bigger fly is a slower fly, and its dancing should be slower too.
    const rate = 1 / Math.max(1, s.k);
    this.time += dt;

    this.updateState(dt, s);

    const pose = this.pose;
    const damp = s.reducedMotion ? 0.35 : 1;

    // --- envelope-driven bob ------------------------------------------------
    if (s.envPeak) this.bobEnergy = Math.min(1.6, this.bobEnergy + 0.55 * Math.min(1.4, 0.25 + s.approval));
    this.bobEnergy *= Math.exp(-dt / (0.16 / rate));
    this.antennaEnergy += (Math.min(1, s.joRate / 45) - this.antennaEnergy) * Math.min(1, dt * 8);

    pose.bob = -this.bobEnergy * 9 * damp;
    pose.lean = this.bobEnergy * 3.5 * damp;
    pose.headTilt = this.bobEnergy * 7 * damp * Math.min(1.2, 0.3 + s.approval);
    pose.abdomen = this.bobEnergy * 4 * damp;

    // Antennae vibrate with sensory drive. Fast, but tiny in amplitude.
    pose.antennaVibe =
      this.antennaEnergy * 7 * damp * Math.sin(this.time * 46 * rate) + this.antennaEnergy * 2 * damp;

    // --- legs ---------------------------------------------------------------
    const legSpeed = (1.4 + Math.min(9, s.relayRate / 4)) * rate;
    this.legPhase += dt * legSpeed;
    pose.legPhase = this.legPhase;
    pose.legSwing = (this.state === 'idle' ? 4 : 9 + 7 * Math.min(1, s.approval)) * damp;

    // --- grooming -----------------------------------------------------------
    const groomTarget = this.state === 'grooming' ? 1 : 0;
    this.groomBlend += (groomTarget - this.groomBlend) * Math.min(1, dt * 6);
    pose.groom = this.groomBlend;
    if (this.state === 'grooming') {
      pose.legSwing *= 0.15;
      pose.headTilt += Math.sin(this.time * 9 * rate) * 5 * damp;
    }

    // --- wings --------------------------------------------------------------
    this.updateWings(dt, s, damp, rate);

    // --- locomotion ---------------------------------------------------------
    this.updateLocomotion(dt, s, damp, rate);

    return pose;
  }

  private updateState(dt: number, s: FlySignals): void {
    this.groomCooldown = Math.max(0, this.groomCooldown - dt);

    // Grooming wins over everything: an overstimulated fly stops dancing.
    if (s.groomRate > s.groomThreshold) this.groomTimer += dt;
    else this.groomTimer = 0;

    if (this.state === 'grooming') {
      if (s.groomRate <= s.groomThreshold && this.groomTimer === 0) {
        this.state = 'idle';
        this.groomCooldown = GROOM_COOLDOWN;
      }
      return;
    }
    if (this.groomTimer >= GROOM_HOLD && this.groomCooldown === 0) {
      this.state = 'grooming';
      return;
    }

    // Breakout flight, held for long enough that it reads as a decision.
    if (s.approval > BREAKOUT_ABOVE) this.breakoutTimer += dt;
    else this.breakoutTimer = 0;

    if (this.state === 'breakout') {
      this.breakoutProgress += dt * 0.45;
      if (this.breakoutProgress >= 1) {
        this.breakoutProgress = 0;
        this.breakoutTimer = 0;
        this.state = 'courting';
      }
      return;
    }
    if (this.breakoutTimer >= BREAKOUT_HOLD && !s.reducedMotion) {
      this.state = 'breakout';
      this.breakoutProgress = 0;
      return;
    }

    if (s.approval < IDLE_BELOW) this.state = 'idle';
    else if (s.approval >= COURT_ABOVE) this.state = 'courting';
    else this.state = 'dancing';
  }

  /**
   * Male: unilateral wing extension, alternating sides, which is what courtship
   * song actually looks like. Female: no extension, a subtle shimmer instead —
   * artistic licence, flagged in About.
   */
  private updateWings(dt: number, s: FlySignals, damp: number, rate: number): void {
    const pose = this.pose;
    const courting = this.state === 'courting' || this.state === 'breakout';

    if (this.state === 'breakout') {
      const flap = Math.sin(this.time * 34 * rate) * 26;
      pose.wingLeft = -32 + flap;
      pose.wingRight = 30 - flap;
      pose.wingShimmer = 0;
      return;
    }

    if (courting && s.sex === 'male') {
      this.wingTimer += dt;
      if (this.wingTimer > 1.6 / rate) {
        this.wingTimer = 0;
        this.wingSide *= -1;
      }
      const extend = 42 * damp * Math.min(1, s.approval);
      pose.wingLeft = this.wingSide > 0 ? -extend : 0;
      pose.wingRight = this.wingSide > 0 ? 0 : extend;
      pose.wingShimmer = Math.sin(this.time * 60 * rate) * 1.6 * damp;
      return;
    }

    if (courting && s.sex === 'female') {
      pose.wingLeft = -4 * damp;
      pose.wingRight = 4 * damp;
      pose.wingShimmer = Math.sin(this.time * 52 * rate) * 2.4 * damp;
      return;
    }

    pose.wingLeft += (0 - pose.wingLeft) * Math.min(1, dt * 5);
    pose.wingRight += (0 - pose.wingRight) * Math.min(1, dt * 5);
    pose.wingShimmer = 0;
  }

  private updateLocomotion(dt: number, s: FlySignals, damp: number, rate: number): void {
    const pose = this.pose;

    if (this.state === 'breakout') {
      // One loop over the dance floor, then back down.
      const p = this.breakoutProgress;
      pose.x = Math.sin(p * Math.PI * 2) * 46;
      pose.y = -Math.sin(p * Math.PI) * 52;
      pose.scale = 1 - Math.sin(p * Math.PI) * 0.22;
      pose.opacity = 1;
      this.facing = Math.cos(p * Math.PI * 2) >= 0 ? 1 : -1;
      pose.facing = this.facing;
      return;
    }

    pose.scale += (1 - pose.scale) * Math.min(1, dt * 4);
    pose.opacity = 1;

    if (this.state === 'courting' && s.sex === 'female') {
      // Stops wandering, turns to face the speaker, sways in time.
      this.wanderTarget = 0;
      this.facing = 1;
      pose.x += (0 - pose.x) * Math.min(1, dt * 3);
      pose.x += Math.sin(this.time * 3.2 * rate) * 5 * damp * dt * 12;
      pose.y += (0 - pose.y) * Math.min(1, dt * 3);
      pose.facing = 1;
      return;
    }

    if (this.state === 'grooming') {
      pose.x += (pose.x > 0 ? -1 : 1) * 0;
      pose.facing = this.facing;
      return;
    }

    // Idle and dancing both wander, idle more aimlessly.
    this.wander += dt;
    const period = this.state === 'idle' ? 4.2 : 2.6;
    if (this.wander > period / rate) {
      this.wander = 0;
      this.wanderTarget = (Math.sin(this.time * 12.9898) * 43758.5453) % 1;
      // Kept well inside the viewBox: the wings are wide, and a stage with
      // overflow hidden will clip a fly that wanders too far.
      this.wanderTarget = ((this.wanderTarget + 1) % 1) * 74 - 37;
      this.facing = this.wanderTarget > pose.x ? 1 : -1;
    }
    pose.x += (this.wanderTarget - pose.x) * Math.min(1, dt * (this.state === 'idle' ? 0.7 : 1.3));
    pose.y += (0 - pose.y) * Math.min(1, dt * 4);
    pose.facing = this.facing;
  }
}
