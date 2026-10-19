import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDialogFocus } from '../src/useDialogFocus.mjs';

function fixture() {
  const document = new EventTarget(); document.body = { style: { overflow: 'auto' } };
  const node = (name, visible = true) => ({ name, isConnected: true, getClientRects: () => visible ? [{}] : [], focus() { document.activeElement = this; } });
  const before = node('before'); const first = node('first'); const hidden = node('hidden', false); const last = node('last');
  document.activeElement = before;
  const dialog = { querySelector: () => first, querySelectorAll: () => [first, hidden, last], contains: (target) => [first, hidden, last].includes(target), focus() { document.activeElement = this; } };
  const key = (name, shiftKey = false) => { const event = new Event('keydown', { cancelable: true }); Object.assign(event, { key: name, shiftKey }); document.dispatchEvent(event); return event; };
  return { document, before, first, last, dialog, key };
}

test('foco inicial, ciclo Tab e Shift+Tab, Escape e retorno ao botão anterior', () => {
  const f = fixture(); let closed = 0;
  const dispose = installDialogFocus({ dialog: f.dialog, document: f.document, onClose: () => closed++ });
  assert.equal(f.document.activeElement, f.first); assert.equal(f.document.body.style.overflow, 'hidden');
  assert.equal(f.key('Tab', true).defaultPrevented, true); assert.equal(f.document.activeElement, f.last);
  assert.equal(f.key('Tab').defaultPrevented, true); assert.equal(f.document.activeElement, f.first);
  f.document.activeElement = f.before; f.key('Tab'); assert.equal(f.document.activeElement, f.first);
  assert.equal(f.key('Escape').defaultPrevented, true); assert.equal(closed, 1);
  dispose(); assert.equal(f.document.activeElement, f.before); assert.equal(f.document.body.style.overflow, 'auto');
  f.key('Escape'); assert.equal(closed, 1);
});

test('não tenta recuperar um elemento removido e aceita diálogo ainda não montado', () => {
  const f = fixture(); const dispose = installDialogFocus({ dialog: f.dialog, document: f.document });
  f.before.isConnected = false; dispose(); assert.equal(f.document.activeElement, f.first);
  assert.doesNotThrow(() => installDialogFocus({ dialog: null, document: f.document })());
});
