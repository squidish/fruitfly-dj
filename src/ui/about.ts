/**
 * The About panel.
 *
 * Renders src/core/ASSUMPTIONS.md directly, so the list of modelling
 * assumptions in the app and the one in the repository cannot drift apart.
 */

import assumptions from '../core/ASSUMPTIONS.md?raw';
import { ABOUT_INTRO, DANCE_NOTE, PRIVACY_NOTE, SAFETY_NOTE } from './copy.ts';

export interface AboutInfo {
  source: 'real' | 'toy';
  circuitName: string;
  n: number;
  edges: number;
  sex: string;
  provenance: string;
  citations: string[];
  warnings: string[];
  tracks: { title: string; artist: string; licence: string; source: string }[];
}

/**
 * Minimal Markdown: headings, lists, paragraphs, `code`, **bold** and *italic*.
 * Everything is inserted as text, never as HTML, so the document can never
 * inject markup into the page.
 */
function renderMarkdown(md: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = md.split('\n');
  let list: HTMLUListElement | null = null;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const p = document.createElement('p');
    applyInline(p, paragraph.join(' '));
    frag.append(p);
    paragraph = [];
  };
  const flushList = () => {
    if (list) frag.append(list);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(4, heading[1].length + 1);
      const h = document.createElement(`h${level}`);
      applyInline(h, heading[2]);
      frag.append(h);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list) list = document.createElement('ul');
      const li = document.createElement('li');
      applyInline(li, bullet[1]);
      list.append(li);
      continue;
    }

    if (/^\s{4,}\S/.test(raw)) {
      flushParagraph();
      flushList();
      const pre = document.createElement('pre');
      pre.textContent = raw.replace(/^ {4}/, '');
      frag.append(pre);
      continue;
    }

    if (line === '') {
      flushParagraph();
      flushList();
      continue;
    }
    if (list) {
      // Continuation of the previous bullet.
      const last = list.lastElementChild;
      if (last) {
        last.append(' ');
        applyInline(last as HTMLElement, line.trim(), true);
        continue;
      }
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return frag;
}

/** Inline emphasis, applied as real elements around plain text nodes. */
function applyInline(host: HTMLElement, text: string, append = false): void {
  if (!append) host.textContent = '';
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) host.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = token.slice(2, -2);
      host.append(b);
    } else if (token.startsWith('`')) {
      const c = document.createElement('code');
      c.textContent = token.slice(1, -1);
      host.append(c);
    } else {
      const i = document.createElement('em');
      i.textContent = token.slice(1, -1);
      host.append(i);
    }
    last = match.index + token.length;
  }
  if (last < text.length) host.append(text.slice(last));
}

function section(title: string, body: string | Node): HTMLElement {
  const s = document.createElement('section');
  const h = document.createElement('h3');
  h.textContent = title;
  s.append(h);
  if (typeof body === 'string') {
    const p = document.createElement('p');
    p.textContent = body;
    s.append(p);
  } else {
    s.append(body);
  }
  return s;
}

export function renderAbout(host: HTMLElement, info: AboutInfo): void {
  host.innerHTML = '';

  const intro = document.createElement('div');
  for (const para of ABOUT_INTRO) {
    const p = document.createElement('p');
    p.textContent = para;
    intro.append(p);
  }
  host.append(intro);

  const circuit = document.createElement('dl');
  circuit.className = 'about-facts';
  const facts: [string, string][] = [
    ['Circuit', `${info.circuitName} (${info.source === 'real' ? 'real data' : 'toy'})`],
    ['Size', `${info.n} neurons, ${info.edges} edges`],
    ['Sex', info.sex],
  ];
  for (const [term, def] of facts) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = def;
    circuit.append(dt, dd);
  }
  host.append(section('This circuit', circuit));
  host.append(section('Provenance', info.provenance));

  if (info.warnings.length > 0) {
    const ul = document.createElement('ul');
    for (const w of info.warnings) {
      const li = document.createElement('li');
      li.textContent = w;
      ul.append(li);
    }
    host.append(section('Loader notes', ul));
  }

  if (info.citations.length > 0) {
    const ul = document.createElement('ul');
    for (const c of info.citations) {
      const li = document.createElement('li');
      li.textContent = c;
      ul.append(li);
    }
    host.append(section('Citations', ul));
  }

  host.append(section('The dance', DANCE_NOTE));
  host.append(section('Flashing and motion', SAFETY_NOTE));
  host.append(section('Privacy', PRIVACY_NOTE));

  if (info.tracks.length > 0) {
    const ul = document.createElement('ul');
    for (const t of info.tracks) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = t.source;
      a.textContent = `${t.title} — ${t.artist}`;
      a.rel = 'noopener noreferrer';
      a.target = '_blank';
      li.append(a, document.createTextNode(` (${t.licence})`));
      ul.append(li);
    }
    host.append(section('Credits', ul));
  }

  const assumptionsSection = document.createElement('section');
  assumptionsSection.className = 'about-assumptions';
  assumptionsSection.append(renderMarkdown(assumptions));
  host.append(assumptionsSection);
}
