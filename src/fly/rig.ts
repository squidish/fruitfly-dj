/**
 * The fly rig: inject the SVG, hold references to each moving part, and write
 * one pose per animation frame.
 *
 * Transforms are composed here as translate(pivot) rotate translate(-pivot)
 * instead of leaning on CSS transform-box, which browsers still disagree about
 * for SVG elements.
 */

import flySvg from './fly.svg?raw';

/** Pivot per part, in the SVG's own viewBox coordinates. */
const PIVOTS: Record<string, [number, number]> = {
  head: [152, 86],
  'antenna-l': [172, 60],
  'antenna-r': [180, 58],
  'wing-l': [120, 54],
  'wing-r': [124, 66],
  'leg-f-l': [140, 108],
  'leg-m-l': [118, 110],
  'leg-b-l': [96, 106],
  'leg-f-r': [144, 106],
  'leg-m-r': [122, 108],
  'leg-b-r': [100, 104],
  abdomen: [104, 92],
  thorax: [124, 88],
};

export interface Pose {
  /** Whole-fly position offset, in viewBox units. */
  x: number;
  y: number;
  /** 1 faces right, -1 faces left. */
  facing: number;
  scale: number;
  /** Vertical body bob. */
  bob: number;
  /** Body lean, degrees. */
  lean: number;
  /** Head tilt, degrees. */
  headTilt: number;
  /** Antennal vibration amplitude, degrees. */
  antennaVibe: number;
  /** Leg cycle phase in radians, and swing amplitude in degrees. */
  legPhase: number;
  legSwing: number;
  /** Wing angles in degrees; unilateral extension uses one at a time. */
  wingLeft: number;
  wingRight: number;
  /** Small high-frequency wing tremor. */
  wingShimmer: number;
  /** 0-1: front legs up at the head, cleaning. */
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
    headTilt: 0,
    antennaVibe: 0,
    legPhase: 0,
    legSwing: 0,
    wingLeft: 0,
    wingRight: 0,
    wingShimmer: 0,
    groom: 0,
    abdomen: 0,
    opacity: 1,
  };
}

const LEGS_LEFT = ['leg-f-l', 'leg-m-l', 'leg-b-l'];
const LEGS_RIGHT = ['leg-f-r', 'leg-m-r', 'leg-b-r'];

function rotateAbout(part: string, deg: number, extra = ''): string {
  const p = PIVOTS[part];
  if (!p) return extra;
  return `translate(${p[0]} ${p[1]}) rotate(${deg.toFixed(2)}) translate(${-p[0]} ${-p[1]})${extra ? ` ${extra}` : ''}`;
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

    this.root.setAttribute(
      'transform',
      `translate(${pose.x.toFixed(2)} ${(pose.y + pose.bob).toFixed(2)}) ` +
        `translate(120 96) scale(${(pose.facing * pose.scale).toFixed(3)} ${pose.scale.toFixed(3)}) translate(-120 -96)`,
    );
    this.root.setAttribute('opacity', pose.opacity.toFixed(3));
    this.body.setAttribute('transform', rotateAbout('thorax', pose.lean));

    this.set('head', rotateAbout('head', pose.headTilt));
    this.set('abdomen', rotateAbout('abdomen', pose.abdomen));

    // Antennae vibrate in antiphase, which reads as vibration rather than a nod.
    this.set('antenna-l', rotateAbout('antenna-l', pose.antennaVibe));
    this.set('antenna-r', rotateAbout('antenna-r', -pose.antennaVibe * 0.8));

    this.set('wing-l', rotateAbout('wing-l', pose.wingLeft + pose.wingShimmer));
    this.set('wing-r', rotateAbout('wing-r', pose.wingRight - pose.wingShimmer));

    // Tripod gait: front-left, middle-right and back-left move together.
    LEGS_LEFT.forEach((id, i) => {
      const phase = pose.legPhase + i * 2.1;
      const groomLift = id === 'leg-f-l' ? -pose.groom * 58 : 0;
      this.set(id, rotateAbout(id, Math.sin(phase) * pose.legSwing + groomLift));
    });
    LEGS_RIGHT.forEach((id, i) => {
      const phase = pose.legPhase + i * 2.1 + Math.PI;
      const groomLift = id === 'leg-f-r' ? -pose.groom * 52 : 0;
      this.set(id, rotateAbout(id, Math.sin(phase) * pose.legSwing + groomLift));
    });
  }

  private set(id: string, transform: string): void {
    this.parts.get(id)?.setAttribute('transform', transform);
  }
}
