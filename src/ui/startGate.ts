/**
 * The start gate.
 *
 * Browsers will not let an AudioContext start without a user gesture, so the
 * context is created and resumed inside this click. It doubles as the place to
 * say, before anything happens, that nothing is uploaded and nothing is
 * downloaded.
 */

import { START_GATE, TAGLINE, TITLE } from './copy.ts';

export function showStartGate(host: HTMLElement, onStart: () => Promise<void>): void {
  host.innerHTML = '';
  host.hidden = false;

  const card = document.createElement('div');
  card.className = 'gate-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', 'gate-title');

  const h1 = document.createElement('h1');
  h1.id = 'gate-title';
  h1.textContent = TITLE;

  const tagline = document.createElement('p');
  tagline.className = 'gate-tagline';
  tagline.textContent = TAGLINE;

  const body = document.createElement('p');
  body.className = 'gate-body';
  body.textContent = START_GATE.body;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'gate-btn';
  button.textContent = START_GATE.button;

  const hint = document.createElement('p');
  hint.className = 'gate-hint';
  hint.textContent = START_GATE.hint;

  const error = document.createElement('p');
  error.className = 'gate-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Waking…';
    error.hidden = true;
    try {
      await onStart();
      host.hidden = true;
    } catch (err) {
      error.hidden = false;
      error.textContent = `Could not start audio: ${(err as Error).message}`;
      button.disabled = false;
      button.textContent = START_GATE.button;
    }
  });

  card.append(h1, tagline, body, button, hint, error);
  host.append(card);
  button.focus();
}

/** Full-page failure, with a reload button. Used when the worker cannot recover. */
export function showFatal(host: HTMLElement, message: string): void {
  host.innerHTML = '';
  host.hidden = false;
  const card = document.createElement('div');
  card.className = 'gate-card';
  card.setAttribute('role', 'alert');

  const h1 = document.createElement('h1');
  h1.textContent = 'The fly has stopped responding';

  const body = document.createElement('p');
  body.className = 'gate-body';
  body.textContent = message;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'gate-btn';
  button.textContent = 'Reload';
  button.addEventListener('click', () => window.location.reload());

  card.append(h1, body, button);
  host.append(card);
  button.focus();
}
