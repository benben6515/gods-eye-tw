/**
 * Mobile Shell CCTV player sheet (P2).
 *
 * At ≤720px mobile-shell.css turns #cctv-panel into a bottom sheet (~60dvh).
 * This module adds the gesture layer on a grab handle: drag down past the
 * threshold closes the panel through the app's OWN collapse button (the same
 * path a desktop click takes, so persistence and auto-expand logic stay in
 * sync); drag up — or a plain tap — toggles fullscreen.
 */
const MOBILE_QUERY = '(max-width: 720px)';

export function installPlayerSheet({
  document: documentImpl = document,
  windowRef = globalThis.window,
  panelId = 'cctv-panel',
  closeThresholdPx = 110,
  fullscreenThresholdPx = 70,
} = {}) {
  if (!windowRef?.matchMedia) return { detach() {} };
  const doc = documentImpl;
  let handle = null;
  let drag = null;

  const panel = () => doc.getElementById(panelId);

  const ensureHandle = () => {
    const owner = panel();
    if (!owner) return null;
    if (!handle || !handle.isConnected) {
      handle = doc.createElement('button');
      handle.id = 'cctv-sheet-handle';
      handle.type = 'button';
      handle.className = 'cctv-sheet-handle';
      handle.setAttribute('aria-label', '拖動：下滑關閉，點一下全螢幕');
      owner.prepend(handle);
    }
    return handle;
  };

  const onPointerDown = (event) => {
    if (!windowRef.matchMedia(MOBILE_QUERY).matches) return;
    drag = { startY: event.clientY, dy: 0, moved: false };
    panel()?.classList.add('player-dragging');
    handle?.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!drag) return;
    drag.dy = event.clientY - drag.startY;
    if (Math.abs(drag.dy) > 6) drag.moved = true;
    panel()?.style.setProperty(
      '--player-drag',
      `${Math.max(-160, drag.dy)}px`,
    );
  };

  const onPointerUp = () => {
    if (!drag) return;
    const owner = panel();
    owner?.classList.remove('player-dragging');
    owner?.style.removeProperty('--player-drag');
    if (drag.dy > closeThresholdPx) {
      owner?.querySelector('[data-collapse-target]')?.click();
    } else if (drag.dy < -fullscreenThresholdPx) {
      owner?.classList.add('player-fullscreen');
    } else if (!drag.moved) {
      owner?.classList.toggle('player-fullscreen');
    }
    drag = null;
  };

  const start = ensureHandle();
  start?.addEventListener('pointerdown', onPointerDown);
  windowRef.addEventListener('pointermove', onPointerMove);
  windowRef.addEventListener('pointerup', onPointerUp);
  windowRef.addEventListener('pointercancel', onPointerUp);

  return {
    detach() {
      handle?.remove();
      handle = null;
      windowRef.removeEventListener('pointermove', onPointerMove);
      windowRef.removeEventListener('pointerup', onPointerUp);
      windowRef.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
