/**
 * The fly rig: inject the SVG, hold references to each moving part, and write
 * one pose per animation frame.
 *
 * The fly stands upright and faces the viewer, so the vocabulary is human:
 * bob, hip sway, stepping legs and swinging arms. Six insect limbs become two
 * legs and two pairs of arms. None of that is anatomically defensible and none
 * of it was ever meant to be -- the dance is an artistic mapping of network
 * activity, which ASSUMPTIONS.md states plainly.
 *
 * Transforms are composed here as translate(pivot) rotate translate(-pivot)
 * instead of leaning on CSS transform-box, which browsers still disagree about
 * for SVG elements.
 */

import flySvg from './fly.svg?raw';

/** Pivot per part, in the SVG's own viewBox coordinates. */
const PIVOTS: Record<string, [number, number]> = {
  head: [120, 100],
  'antenna-l': [102, 34],
  'antenna-r': [138, 34],
  'wing-l': [110, 106],
  'wing-r': [130, 106],
  'arm-ul': [86, 116],
  'arm-ur': [154, 116],
  'arm-ll': [92, 146],
  'arm-lr': [148, 146],
  'leg-l': [100, 198],
  'leg-r': [140, 198],
  abdomen: [120, 150],
  /** The hips: what the torso leans and sways about. */
  body: [120, 200],
};

/** Centre of the viewBox, used as the origin for whole-fly scale and facing. */
const CENTRE: [number, number] = [120, 150];

export interface Pose {
  /** Whole-fly position offset, in viewBox units. */
  x: number;
  y: number;
  /** 1 faces right, -1 faces left. */
  facing: number;
  scale: number;
  /** Vertical body bob, in viewBox units. Negative is up. */
  bob: number;
  /** Torso lean about the hips, degrees. */
  lean: number;
  /** Lateral hip offset, in viewBox units. */
  hipSway: number;
  /** Head tilt, degrees. */
  headTilt: number;
  /** Antennal vibration amplitude, degrees. */
  antennaVibe: number;
  /** Gait phase in radians, and step amplitude in degrees. */
  legPhase: number;
  legSwing: number;
  /** Arm swing amplitude, degrees. */
  armSwing: number;
  /** 0-1: how high the arms are held. 0 is hanging, 1 is up. */
  armRaise: number;
  /** Wing angles in degrees; unilateral extension uses one side at a time. */
  wingLeft: number;
  wingRight: number;
  /** Small high-frequency wing tremor. */
  wingShimmer: number;
  /** 0-1: upper arms up at the antennae, cleaning. */
  groom: number;
  /** Abdomen flex, degrees. */
  abdomen: number;
  /** Overall opacity, used when the fly is off on a flight loop. */
  opacity: number;
}

export function neutralPose(): Pose {
  return {
    x: 0,
    y: 0,
    facing: 1,
    scale: 1,
    bob: 0,
    lean: 0,
    hipSway: 0,
    headTilt: 0,
    antennaVibe: 0,
    legPhase: 0,
    legSwing: 0,
    armSwing: 0,
    armRaise: 0,
    wingLeft: 0,
    wingRight: 0,
    wingShimmer: 0,
    groom: 0,
    abdomen: 0,
    opacity: 1,
  };
}

/** Resting-to-raised arc for each arm, degrees at armRaise = 1. */
const ARM_RAISE_DEG = { 'arm-ul': 34, 'arm-ur': 34, 'arm-ll': 26, 'arm-lr': 26 } as const;
/** How far the upper arms travel to reach the antennae when grooming. */
const GROOM_DEG = 74;

function rotateAbout(part: string, deg: number): string {
  const p = PIVOTS[part];
  if (!p) return '';
  return `translate(${p[0]} ${p[1]}) rotate(${deg.toFixed(2)}) translate(${-p[0]} ${-p[1]})`;
}

export class FlyRig {
  private root: SVGGElement | null = null;
  private body: SVGGElement | null = null;
  private parts = new Map<string, SVGGElement>();
  readonly svg: SVGSVGElement | null;

  constructor(host: HTMLElement) {
    host.innerHTML = flySvg;
    this.svg = host.querySelector('svg');
    this.root = host.querySelector('#fly-root');
    this.body = host.querySelector('#fly-body');
    for (const id of Object.keys(PIVOTS)) {
      const el = host.querySelector<SVGGElement>(`#${id}`);
      if (el) this.parts.set(id, el);
    }
  }

  apply(pose: Pose): void {
    if (!this.root || !this.body) return;

    const [cx, cy] = CENTRE;
    this.root.setAttribute(
      'transform',
      `translate(${pose.x.toFixed(2)} ${(pose.y + pose.bob).toFixed(2)}) ` +
        `translate(${cx} ${cy}) scale(${(pose.facing * pose.scale).toFixed(3)} ${pose.scale.toFixed(3)}) ` +
        `translate(${-cx} ${-cy})`,
    );
    this.root.setAttribute('opacity', pose.opacity.toFixed(3));

    // The torso sways and leans about the hips; the legs stay planted, because
    // they live outside this group.
    this.body.setAttribute(
      'transform',
      `translate(${pose.hipSway.toFixed(2)} 0) ${rotateAbout('body', pose.lean)}`,
    );

    this.set('head', rotateAbout('head', pose.headTilt));
    this.set('abdomen', rotateAbout('abdomen', pose.abdomen));

    // Antennae vibrate in antiphase, which reads as vibration rather than a nod.
    this.set('antenna-l', rotateAbout('antenna-l', pose.antennaVibe));
    this.set('antenna-r', rotateAbout('antenna-r', -pose.antennaVibe * 0.8));

    // Wings rest swept up and out. wing-l points up-left, so swinging it
    // OUTWARD (towards horizontal) is a further negative turn; wing-r points
    // up-right, so outward is positive. Getting these two signs the wrong way
    // round folds both wings up behind the head, where the extension is
    // invisible and the courtship display reads as nothing happening.
    this.set('wing-l', rotateAbout('wing-l', -pose.wingLeft - pose.wingShimmer));
    this.set('wing-r', rotateAbout('wing-r', pose.wingRight + pose.wingShimmer));

    // Legs alternate: a step, not a march.
    this.set('leg-l', rotateAbout('leg-l', Math.sin(pose.legPhase) * pose.legSwing));
    this.set('leg-r', rotateAbout('leg-r', -Math.sin(pose.legPhase + Math.PI) * pose.legSwing));

    // Arms: a raised baseline plus a swing, with the lower pair half a cycle
    // behind the upper so all four never move as one block.
    const groomLift = pose.groom * GROOM_DEG;
    this.setArm('arm-ul', pose, pose.legPhase + Math.PI, -1, groomLift);
    this.setArm('arm-ur', pose, pose.legPhase, 1, groomLift);
    this.setArm('arm-ll', pose, pose.legPhase + Math.PI * 0.5, -1, 0);
    this.setArm('arm-lr', pose, pose.legPhase + Math.PI * 1.5, 1, 0);
  }

  /** `mirror` is -1 for the viewer's left arms, where raising is a negative turn. */
  private setArm(id: keyof typeof ARM_RAISE_DEG, pose: Pose, phase: number, mirror: -1 | 1, groomLift: number): void {
    const raise = pose.armRaise * ARM_RAISE_DEG[id] + groomLift;
    const swing = Math.sin(phase) * pose.armSwing;
    this.set(id, rotateAbout(id, mirror * (raise + swing)));
  }

  private set(id: string, transform: string): void {
    this.parts.get(id)?.setAttribute('transform', transform);
  }
}
