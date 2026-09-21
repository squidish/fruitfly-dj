/**
 * The control panel, generated entirely from src/state/params.ts.
 *
 * Nothing here knows what any individual knob means; adding a parameter is a
 * one-line change to the schema. Every control is labelled, keyboard operable,
 * and has its own reset-to-default.
 */

import {
  GROUP_LABELS,
  PARAMS,
  PARAM_BY_KEY,
  clampValue,
  type ParamDef,
  type ParamGroup,
  type ParamState,
  type ParamValue,
  type RangeDef,
  type Tier,
} from '../state/params.ts';

export interface ControlsOptions {
  onChange: (key: string, value: ParamValue) => void;
  onReset: () => void;
  onShare: () => void;
  onCompare: () => void;
}

function formatValue(def: ParamDef, value: ParamValue): string {
  if (def.type !== 'range') return '';
  const scale = def.scale ?? 1;
  const n = Number(value) * scale;
  const precision = def.precision ?? (scale === 1000 ? 0 : 2);
  return `${n.toFixed(precision)}${def.unit ? ` ${def.unit === 'ms' ? 'ms' : def.unit}` : ''}`;
}

export class Controls {
  private host: HTMLElement;
  private opts: ControlsOptions;
  private inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  private readouts = new Map<string, HTMLElement>();
  private rows = new Map<string, HTMLElement>();
  private state: ParamState;
  private tier: Tier = 'basic';

  constructor(host: HTMLElement, state: ParamState, opts: ControlsOptions) {
    this.host = host;
    this.state = { ...state };
    this.opts = opts;
    this.build();
  }

  private build(): void {
    this.host.innerHTML = '';

    const tierBar = document.createElement('div');
    tierBar.className = 'tier-bar';
    tierBar.setAttribute('role', 'tablist');
    tierBar.setAttribute('aria-label', 'Control detail');
    for (const tier of ['basic', 'advanced'] as Tier[]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tier-btn';
      btn.textContent = tier === 'basic' ? 'Basic' : 'Advanced';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(tier === this.tier));
      btn.addEventListener('click', () => this.setTier(tier));
      tierBar.append(btn);
    }

    const actions = document.createElement('div');
    actions.className = 'panel-actions';
    actions.append(
      this.actionButton('Compare wirings', () => this.opts.onCompare()),
      this.actionButton('Copy link', () => this.opts.onShare()),
      this.actionButton('Reset all', () => this.opts.onReset()),
    );

    this.host.append(tierBar, actions);

    const byGroup = new Map<ParamGroup, ParamDef[]>();
    for (const def of PARAMS) {
      const list = byGroup.get(def.group) ?? [];
      list.push(def);
      byGroup.set(def.group, list);
    }

    for (const [group, defs] of byGroup) {
      const section = document.createElement('section');
      section.className = 'control-group';
      section.dataset.group = group;

      const heading = document.createElement('h3');
      heading.textContent = GROUP_LABELS[group];
      section.append(heading);

      for (const def of defs) section.append(this.buildRow(def));
      this.host.append(section);
    }

    this.setTier(this.tier);
    this.sync(this.state);
  }

  private actionButton(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'action-btn';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  private buildRow(def: ParamDef): HTMLElement {
    const row = document.createElement('div');
    row.className = 'control-row';
    row.dataset.tier = def.tier;
    row.dataset.key = def.key;

    const id = `ctl-${def.key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.className = 'control-label';
    label.textContent = def.label;
    if (def.affectsCalibration) {
      const mark = document.createElement('span');
      mark.className = 'recal-mark';
      mark.textContent = '●';
      mark.title = 'Changing this re-measures the fly’s yardstick.';
      label.append(mark);
    }

    const head = document.createElement('div');
    head.className = 'control-head';
    head.append(label);

    if (def.type === 'range') {
      const readout = document.createElement('output');
      readout.className = 'control-value';
      readout.htmlFor = id;
      head.append(readout);
      this.readouts.set(def.key, readout);
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset-btn';
    reset.textContent = '↺';
    reset.title = `Reset ${def.label} to default`;
    reset.setAttribute('aria-label', `Reset ${def.label} to default`);
    reset.addEventListener('click', () => this.emit(def.key, def.default));
    head.append(reset);

    row.append(head);

    let input: HTMLInputElement | HTMLSelectElement;
    if (def.type === 'select') {
      const select = document.createElement('select');
      select.id = id;
      for (const opt of def.options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        select.append(o);
      }
      select.addEventListener('change', () => this.emit(def.key, select.value));
      input = select;
    } else if (def.type === 'toggle') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.id = id;
      box.className = 'control-toggle';
      box.addEventListener('change', () => this.emit(def.key, box.checked));
      input = box;
    } else {
      const range = document.createElement('input');
      range.type = 'range';
      range.id = id;
      range.min = String(def.min);
      range.max = String(def.max);
      range.step = String(def.step);
      range.addEventListener('input', () => this.emit(def.key, Number(range.value)));
      input = range;
    }

    input.title = def.tooltip;
    input.setAttribute('aria-describedby', `${id}-tip`);
    row.append(input);

    const tip = document.createElement('p');
    tip.className = 'control-tip';
    tip.id = `${id}-tip`;
    tip.textContent = def.tooltip;
    row.append(tip);

    this.inputs.set(def.key, input);
    this.rows.set(def.key, row);
    return row;
  }

  private emit(key: string, value: ParamValue): void {
    const def = PARAM_BY_KEY[key];
    if (!def) return;
    const clamped = clampValue(def, value);
    this.state[key] = clamped;
    this.opts.onChange(key, clamped);
  }

  setTier(tier: Tier): void {
    this.tier = tier;
    this.host.dataset.tier = tier;
    for (const btn of this.host.querySelectorAll<HTMLButtonElement>('.tier-btn')) {
      const isActive = btn.textContent?.toLowerCase() === tier;
      btn.setAttribute('aria-selected', String(isActive));
      btn.classList.toggle('active', isActive);
    }
    for (const [key, row] of this.rows) {
      const def = PARAM_BY_KEY[key];
      row.hidden = tier === 'basic' && def.tier === 'advanced';
    }
  }

  /** Push external state (URL load, preset change, auto-fit) into the widgets. */
  sync(state: ParamState): void {
    this.state = { ...state };
    for (const [key, input] of this.inputs) {
      const def = PARAM_BY_KEY[key];
      const value = state[key];
      if (value === undefined) continue;

      if (def.type === 'toggle') (input as HTMLInputElement).checked = Boolean(value);
      else input.value = String(value);

      const readout = this.readouts.get(key);
      if (readout) readout.textContent = formatValue(def, value);

      const row = this.rows.get(key);
      if (row) {
        const enabled = def.enabledWhen ? def.enabledWhen(state) : true;
        row.classList.toggle('disabled', !enabled);
        input.disabled = !enabled;
        row.classList.toggle('modified', value !== def.default);
      }
    }
  }

  /** Range bounds for a key, so callers can present the same limits. */
  static bounds(key: string): RangeDef | null {
    const def = PARAM_BY_KEY[key];
    return def && def.type === 'range' ? def : null;
  }
}
