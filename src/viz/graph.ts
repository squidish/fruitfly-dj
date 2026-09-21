/**
 * Circuit graph.
 *
 * Type-level by default: one node per cell type, sized by population, which is
 * the view that actually reads at a glance. The per-neuron view is WebGL and
 * draws only the top-N edges by weight, because 3,000 neurons and their
 * synapses are not a Canvas 2D job.
 *
 * Brightness comes from low-passed firing rates, never from per-spike flashes.
 */

import { GROUPS } from '../core/circuit.ts';
import { clear, cssVar, EDGE_EXC, EDGE_INH, fitCanvas, frame, groupColor } from './theme.ts';

export interface GraphData {
  n: number;
  groupOf: Uint8Array;
  typeOf: Uint16Array;
  typeNames: string[];
  edges: { pre: Uint32Array; post: Uint32Array; weight: Float32Array };
  /** FlyWire root ids, when the circuit is real. */
  rootIds?: (string | undefined)[];
}

interface TypeNode {
  type: number;
  name: string;
  group: number;
  count: number;
  members: number[];
  x: number;
  y: number;
  r: number;
  rate: number;
}

interface TypeEdge {
  from: number;
  to: number;
  weight: number;
}

export type GraphMode = 'type' | 'neuron';

export class CircuitGraph {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private data: GraphData | null = null;
  private nodes: TypeNode[] = [];
  private typeEdges: TypeEdge[] = [];
  private nodeIndex = new Map<number, number>();
  private hover: { label: string; x: number; y: number } | null = null;
  private pointer: { x: number; y: number } | null = null;
  mode: GraphMode = 'type';

  // Per-neuron layout, in unit coordinates.
  private nx = new Float32Array(0);
  private ny = new Float32Array(0);
  private glProgram: WebGLProgram | null = null;
  private edgeBuffer: WebGLBuffer | null = null;
  private nodeBuffer: WebGLBuffer | null = null;
  private edgeVerts = new Float32Array(0);
  private nodeVerts = new Float32Array(0);
  private glFailed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect();
      this.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.hover = null;
    });
  }

  setData(data: GraphData): void {
    this.data = data;
    this.buildTypeGraph();
    this.buildNeuronLayout();
    this.glFailed = false;
    this.glProgram = null;
  }

  /** Aggregate neurons into cell types and sum synaptic mass between them. */
  private buildTypeGraph(): void {
    const d = this.data;
    if (!d) return;
    const byType = new Map<number, TypeNode>();
    for (let i = 0; i < d.n; i++) {
      const t = d.typeOf[i];
      let node = byType.get(t);
      if (!node) {
        node = {
          type: t,
          name: d.typeNames[t] ?? `type ${t}`,
          group: d.groupOf[i],
          count: 0,
          members: [],
          x: 0,
          y: 0,
          r: 0,
          rate: 0,
        };
        byType.set(t, node);
      }
      node.count++;
      node.members.push(i);
    }

    this.nodes = [...byType.values()].sort((a, b) => a.group - b.group || b.count - a.count);
    this.nodeIndex = new Map(this.nodes.map((node, i) => [node.type, i]));

    const acc = new Map<string, TypeEdge>();
    for (let e = 0; e < d.edges.pre.length; e++) {
      const from = this.nodeIndex.get(d.typeOf[d.edges.pre[e]]);
      const to = this.nodeIndex.get(d.typeOf[d.edges.post[e]]);
      if (from === undefined || to === undefined) continue;
      const key = `${from}>${to}`;
      const existing = acc.get(key);
      if (existing) existing.weight += d.edges.weight[e];
      else acc.set(key, { from, to, weight: d.edges.weight[e] });
    }
    this.typeEdges = [...acc.values()].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 220);
  }

  /** Columns by group, spread vertically within each column. */
  private buildNeuronLayout(): void {
    const d = this.data;
    if (!d) return;
    this.nx = new Float32Array(d.n);
    this.ny = new Float32Array(d.n);
    const perGroup: number[][] = GROUPS.map(() => []);
    for (let i = 0; i < d.n; i++) perGroup[d.groupOf[i]].push(i);

    perGroup.forEach((members, g) => {
      const col = (g + 0.5) / GROUPS.length;
      members.forEach((i, j) => {
        // Deterministic zig-zag rather than a random scatter, so the columns
        // stay legible and the picture does not change between reloads.
        const t = (j + 0.5) / members.length;
        this.nx[i] = col + (((j % 5) - 2) / 5) * (0.55 / GROUPS.length);
        this.ny[i] = 0.06 + t * 0.88;
      });
    });

    const e = d.edges;
    this.edgeVerts = new Float32Array(e.pre.length * 2 * 3);
    for (let i = 0; i < e.pre.length; i++) {
      const a = e.pre[i];
      const b = e.post[i];
      const sign = e.weight[i] < 0 ? 0 : 1;
      const o = i * 6;
      this.edgeVerts[o] = this.nx[a];
      this.edgeVerts[o + 1] = this.ny[a];
      this.edgeVerts[o + 2] = sign;
      this.edgeVerts[o + 3] = this.nx[b];
      this.edgeVerts[o + 4] = this.ny[b];
      this.edgeVerts[o + 5] = sign;
    }
    this.nodeVerts = new Float32Array(d.n * 3);
  }

  draw(rates: Float32Array): void {
    if (this.mode === 'neuron' && !this.glFailed) {
      if (this.drawNeurons(rates)) return;
      this.glFailed = true;
    }
    this.drawTypes(rates);
  }

  // ---- type-level, Canvas 2D ---------------------------------------------

  private drawTypes(rates: Float32Array): void {
    const s = fitCanvas(this.canvas);
    if (!s || !this.data) return;
    clear(s);
    const { top } = frame(s);
    const ctx = s.ctx;
    const pad = { l: 14, r: 14, t: top + 6, b: 18 };
    const w = s.width - pad.l - pad.r;
    const h = s.height - pad.t - pad.b;

    const byGroup: TypeNode[][] = GROUPS.map(() => []);
    for (const node of this.nodes) byGroup[node.group].push(node);

    const maxCount = Math.max(1, ...this.nodes.map((n) => n.count));
    byGroup.forEach((column, g) => {
      const cx = pad.l + ((g + 0.5) / GROUPS.length) * w;
      column.forEach((node, j) => {
        node.x = cx;
        node.y = pad.t + ((j + 0.5) / Math.max(1, column.length)) * h;
        node.r = 5 + 13 * Math.sqrt(node.count / maxCount);
        let sum = 0;
        for (const m of node.members) sum += rates[m] ?? 0;
        node.rate = node.members.length > 0 ? sum / node.members.length : 0;
      });
    });

    let maxWeight = 1e-6;
    for (const e of this.typeEdges) maxWeight = Math.max(maxWeight, Math.abs(e.weight));

    for (const e of this.typeEdges) {
      const a = this.nodes[e.from];
      const b = this.nodes[e.to];
      if (!a || !b) continue;
      const inhibitory = e.weight < 0;
      ctx.strokeStyle = inhibitory ? EDGE_INH : EDGE_EXC;
      ctx.lineWidth = 0.4 + 2.4 * (Math.abs(e.weight) / maxWeight);
      // Inhibitory edges are dashed as well as differently coloured, so the
      // distinction survives a colour-blind viewer and a greyscale screenshot.
      ctx.setLineDash(inhibitory ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 + (a.x === b.x ? 26 : 0);
      ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    this.hover = null;
    for (const node of this.nodes) {
      // Brightness from the low-passed rate, per the photosensitivity rules.
      const glow = Math.min(1, node.rate / 40);
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);
      ctx.fillStyle = groupColor(node.group);
      ctx.globalAlpha = 0.35 + 0.6 * glow;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.stroke();

      if (this.pointer) {
        const dx = this.pointer.x - node.x;
        const dy = this.pointer.y - node.y;
        if (dx * dx + dy * dy <= (node.r + 3) ** 2) {
          const root = this.rootIdFor(node);
          this.hover = {
            label: `${node.name} — ${node.count} cells, ${node.rate.toFixed(1)} Hz${root ? ` — ${root}` : ''}`,
            x: node.x,
            y: node.y,
          };
        }
      }
    }

    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = cssVar('--text-dim', '#8b8fa3');
    ctx.textAlign = 'center';
    GROUPS.forEach((g, i) => {
      ctx.fillText(g, pad.l + ((i + 0.5) / GROUPS.length) * w, s.height - 6);
    });
    ctx.textAlign = 'left';

    this.drawHover(ctx, s.width);
  }

  private rootIdFor(node: TypeNode): string | undefined {
    const ids = this.data?.rootIds;
    if (!ids) return undefined;
    const first = node.members[0];
    return first !== undefined ? ids[first] : undefined;
  }

  private drawHover(ctx: CanvasRenderingContext2D, width: number): void {
    if (!this.hover) return;
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    const pad = 6;
    const textWidth = ctx.measureText(this.hover.label).width;
    const x = Math.min(width - textWidth - pad * 2 - 4, Math.max(4, this.hover.x - textWidth / 2));
    const y = Math.max(4, this.hover.y - 30);
    ctx.fillStyle = 'rgba(8, 10, 16, 0.92)';
    ctx.fillRect(x, y, textWidth + pad * 2, 20);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(x, y, textWidth + pad * 2, 20);
    ctx.fillStyle = cssVar('--text', '#dfe3ee');
    ctx.textBaseline = 'middle';
    ctx.fillText(this.hover.label, x + pad, y + 10);
    ctx.textBaseline = 'alphabetic';
  }

  // ---- per-neuron, WebGL --------------------------------------------------

  private initGl(): boolean {
    if (this.gl) return true;
    const gl = (this.canvas.getContext('webgl', { antialias: true, alpha: true }) ??
      this.canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    this.gl = gl;

    const vs = `
      attribute vec3 a;   // x, y, kind (0 inhibitory / 1 excitatory) or rate
      uniform float uPoint;
      varying float vKind;
      void main() {
        vKind = a.z;
        gl_Position = vec4(a.x * 2.0 - 1.0, 1.0 - a.y * 2.0, 0.0, 1.0);
        gl_PointSize = uPoint;
      }`;
    const fs = `
      precision mediump float;
      varying float vKind;
      uniform vec3 uLow;
      uniform vec3 uHigh;
      uniform float uAlpha;
      void main() {
        vec3 c = mix(uLow, uHigh, clamp(vKind, 0.0, 1.0));
        gl_FragColor = vec4(c, uAlpha);
      }`;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
      return sh;
    };
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return false;
    const program = gl.createProgram();
    if (!program) return false;
    gl.attachShader(program, v);
    gl.attachShader(program, f);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;

    this.glProgram = program;
    this.edgeBuffer = gl.createBuffer();
    this.nodeBuffer = gl.createBuffer();
    return true;
  }

  private drawNeurons(rates: Float32Array): boolean {
    if (!this.data) return false;
    if (!this.initGl()) return false;
    const gl = this.gl;
    const program = this.glProgram;
    if (!gl || !program) return false;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.07, 0.08, 0.11, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);

    const aLoc = gl.getAttribLocation(program, 'a');
    const uLow = gl.getUniformLocation(program, 'uLow');
    const uHigh = gl.getUniformLocation(program, 'uHigh');
    const uAlpha = gl.getUniformLocation(program, 'uAlpha');
    const uPoint = gl.getUniformLocation(program, 'uPoint');
    gl.enableVertexAttribArray(aLoc);

    // Edges: magenta for inhibitory, blue for excitatory.
    gl.bindBuffer(gl.ARRAY_BUFFER, this.edgeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.edgeVerts, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(aLoc, 3, gl.FLOAT, false, 0, 0);
    gl.uniform3f(uLow, 0.88, 0.33, 0.56);
    gl.uniform3f(uHigh, 0.47, 0.75, 1.0);
    gl.uniform1f(uAlpha, 0.1);
    gl.uniform1f(uPoint, 1);
    gl.drawArrays(gl.LINES, 0, this.edgeVerts.length / 3);

    // Neurons: brightness from the low-passed rate.
    const n = this.data.n;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      this.nodeVerts[o] = this.nx[i];
      this.nodeVerts[o + 1] = this.ny[i];
      this.nodeVerts[o + 2] = Math.min(1, (rates[i] ?? 0) / 40);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nodeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.nodeVerts, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(aLoc, 3, gl.FLOAT, false, 0, 0);
    gl.uniform3f(uLow, 0.32, 0.34, 0.42);
    gl.uniform3f(uHigh, 1.0, 0.92, 0.7);
    gl.uniform1f(uAlpha, 0.95);
    gl.uniform1f(uPoint, Math.max(2, 3 * dpr));
    gl.drawArrays(gl.POINTS, 0, n);
    return true;
  }

  /** WebGL and Canvas 2D contexts cannot share a canvas, so mode switches reset it. */
  setMode(mode: GraphMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const replacement = this.canvas.cloneNode(false) as HTMLCanvasElement;
    this.canvas.replaceWith(replacement);
    this.canvas = replacement;
    this.gl = null;
    this.glProgram = null;
    this.glFailed = false;
    replacement.addEventListener('pointermove', (e) => {
      const rect = replacement.getBoundingClientRect();
      this.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
    replacement.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.hover = null;
    });
  }
}
