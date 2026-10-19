import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]';

/** Keep keyboard navigation inside a dialog and restore the invoking control. */
export function installDialogFocus({ dialog, document, onClose, initialFocus = '[data-dialog-initial]' }) {
  if (!dialog || !document) return () => {};
  const previous = document.activeElement;
  const previousOverflow = document.body?.style.overflow;
  if (document.body) document.body.style.overflow = 'hidden';
  const visibleControls = () => [...dialog.querySelectorAll(FOCUSABLE)]
    .filter((control) => !control.hidden && control.getClientRects().length);
  (dialog.querySelector(initialFocus) || visibleControls()[0] || dialog).focus?.();
  function keydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose?.(); return; }
    if (event.key !== 'Tab') return;
    const controls = visibleControls(); const first = controls[0]; const last = controls.at(-1);
    if (!first) { event.preventDefault(); dialog.focus?.(); }
    else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  document.addEventListener('keydown', keydown);
  return () => { document.removeEventListener('keydown', keydown); if (document.body) document.body.style.overflow = previousOverflow; if (previous?.isConnected !== false) previous?.focus?.(); };
}

export function useDialogFocus(onClose, options = {}) {
  const ref = useRef(null); const closeRef = useRef(onClose); closeRef.current = onClose;
  const initialFocus = options.initialFocus;
  useEffect(() => installDialogFocus({ dialog: ref.current, document: globalThis.document, onClose: () => closeRef.current?.(), initialFocus }), [initialFocus]);
  return ref;
}
