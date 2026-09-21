/**
 * Stretch view: the soma point cloud, glowing by firing rate, orbit-able.
 *
 * Skipped gracefully when the circuit has no positions (the loader reports
 * pos: null) or when WebGL is unavailable.
 *
 * Implemented in raw WebGL rather than three.js. The spec named three.js, but
 * this view is one buffer of points with an orbit matrix; pulling in a whole
 * scene graph for it would cost more download than the rest of the app puts
 * together. The trade is noted in the README.
 */

import { groupColor } from './theme.ts';

const VS = `
  attribute vec3 aPos;
  attribute float aRate;
  attribute vec3 aColor;
  uniform mat4 uMvp;
  uniform float uScale;
  varying float vRate;
  varying vec3 vColor;
  void main() {
    vRate = aRate;
    vColor = aColor;
    vec4 clip = uMvp * vec4(aPos, 1.0);
    gl_Position = clip;
    gl_PointSize = uScale * (1.0 + 1.6 * aRate) / max(0.4, clip.w);
  }`;

const FS = `
  precision mediump float;
  varying float vRate;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = dot(d, d);
    if (r > 0.25) discard;
    float edge = 1.0 - smoothstep(0.12, 0.25, r);
    vec3 c = mix(vColor * 0.4, mix(vColor, vec3(1.0, 0.96, 0.85), vRate * 0.7), 0.25 + 0.75 * vRate);
    gl_FragColor = vec4(c, edge * (0.35 + 0.65 * vRate));
  }`;

function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/** Perspective * orbit, built directly — no general matrix library needed. */
function mvp(aspect: number, yaw: number, pitch: number, distance: number): Float32Array {
  const p = perspective(Math.PI / 4, aspect, 0.1, 100);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  // View = translate(0,0,-d) * rotX(pitch) * rotY(yaw), column-major.
  const v = new Float32Array(16);
  v[0] = cy;
  v[1] = sp * sy;
  v[2] = -cp * sy;
  v[4] = 0;
  v[5] = cp;
  v[6] = sp;
  v[8] = sy;
  v[9] = -sp * cy;
  v[10] = cp * cy;
  v[14] = -distance;
  v[15] = 1;

  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += p[k * 4 + r] * v[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export class Brain3D {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private posBuffer: WebGLBuffer | null = null;
  private rateBuffer: WebGLBuffer | null = null;
  private colorBuffer: WebGLBuffer | null = null;
  private n = 0;
  private rates = new Float32Array(0);
  private yaw = 0.5;
  private pitch = 0.25;
  private distance = 2.6;
  private dragging = false;
  private last = { x: 0, y: 0 };
  available = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.last = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw += (e.clientX - this.last.x) * 0.008;
      this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch + (e.clientY - this.last.y) * 0.008));
      this.last = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', () => {
      this.dragging = false;
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.distance = Math.max(1.2, Math.min(8, this.distance + e.deltaY * 0.002));
      },
      { passive: false },
    );
  }

  /** Returns false when there are no positions, so the caller can hide the tab. */
  setData(pos: Float32Array | null, groupOf: Uint8Array): boolean {
    if (!pos || pos.length < 3) {
      this.available = false;
      return false;
    }
    if (!this.init()) {
      this.available = false;
      return false;
    }
    const gl = this.gl!;
    this.n = groupOf.length;
    this.rates = new Float32Array(this.n);

    // Centre and normalise into a unit-ish box, so any coordinate system works.
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.n; i++) {
      for (let a = 0; a < 3; a++) {
        const v = pos[i * 3 + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const norm = new Float32Array(this.n * 3);
    for (let i = 0; i < this.n; i++) {
      for (let a = 0; a < 3; a++) {
        norm[i * 3 + a] = ((pos[i * 3 + a] - (min[a] + max[a]) / 2) / span) * 2;
      }
    }

    const colors = new Float32Array(this.n * 3);
    for (let i = 0; i < this.n; i++) {
      const hex = groupColor(groupOf[i]);
      colors[i * 3] = parseInt(hex.slice(1, 3), 16) / 255;
      colors[i * 3 + 1] = parseInt(hex.slice(3, 5), 16) / 255;
      colors[i * 3 + 2] = parseInt(hex.slice(5, 7), 16) / 255;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, norm, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    this.available = true;
    return true;
  }

  private init(): boolean {
    if (this.program) return true;
    const gl = this.canvas.getContext('webgl', { alpha: true, antialias: true });
    if (!gl) return false;
    this.gl = gl;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
    };
    const v = compile(gl.VERTEX_SHADER, VS);
    const f = compile(gl.FRAGMENT_SHADER, FS);
    if (!v || !f) return false;
    const program = gl.createProgram()!;
    gl.attachShader(program, v);
    gl.attachShader(program, f);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;

    this.program = program;
    this.posBuffer = gl.createBuffer();
    this.rateBuffer = gl.createBuffer();
    this.colorBuffer = gl.createBuffer();
    return true;
  }

  draw(rates: Float32Array, spin: boolean): void {
    const gl = this.gl;
    if (!this.available || !gl || !this.program) return;

    if (spin && !this.dragging) this.yaw += 0.002;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.05, 0.06, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.useProgram(this.program);

    for (let i = 0; i < this.n; i++) this.rates[i] = Math.min(1, (rates[i] ?? 0) / 40);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rateBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.rates, gl.DYNAMIC_DRAW);

    const bind = (name: string, buffer: WebGLBuffer | null, size: number) => {
      const loc = gl.getAttribLocation(this.program!, name);
      if (loc < 0) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind('aPos', this.posBuffer, 3);
    bind('aRate', this.rateBuffer, 1);
    bind('aColor', this.colorBuffer, 3);

    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'uMvp'), false, mvp(aspect, this.yaw, this.pitch, this.distance));
    gl.uniform1f(gl.getUniformLocation(this.program, 'uScale'), 5 * dpr);
    gl.drawArrays(gl.POINTS, 0, this.n);
  }
}
