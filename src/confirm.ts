// Accessible modal dialog helpers: light-dismiss (`closedby="any"` + fallback), focus restoration, and destructive confirmation.

import { esc } from './ui';

const initializedDialogs = new WeakSet<HTMLDialogElement>();
const dialogOpeners = new WeakMap<HTMLDialogElement, { id: string; data: [string, string][] }>();
let scrollLock: { html: string; body: string } | undefined;

function rememberOpener(modal: HTMLDialogElement, trigger?: HTMLElement) {
  const el = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (el) {
    dialogOpeners.set(modal, {
      id: el.id,
      data: Object.entries(el.dataset).filter((x): x is [string, string] => x[1] !== undefined),
    });
  }
}

function findOpener(modal: HTMLDialogElement): HTMLElement | null {
  const saved = dialogOpeners.get(modal);
  if (!saved) return null;
  if (saved.id) return document.getElementById(saved.id);
  if (!saved.data.length) return null;
  return (
    Array.from(document.querySelectorAll<HTMLElement>('button, a, [tabindex]')).find(el =>
      saved.data.every(([k, v]) => el.dataset[k] === v)
    ) || null
  );
}

function lockScroll() {
  if (!scrollLock) {
    scrollLock = {
      html: document.documentElement.style.overflow,
      body: document.body.style.overflow,
    };
  }
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
}

function releaseScrollIfIdle() {
  if (!document.querySelector('dialog[open]') && scrollLock) {
    document.documentElement.style.overflow = scrollLock.html;
    document.body.style.overflow = scrollLock.body;
    scrollLock = undefined;
  }
}

/**
 * Enable declarative `closedby="any"` light-dismiss with a coordinate-checked
 * backdrop click fallback for WebViews without `HTMLDialogElement.prototype.closedBy`.
 */
export function enableLightDismiss(dialog: HTMLDialogElement, onAfterClose?: () => void) {
  dialog.setAttribute('closedby', 'any');
  if (initializedDialogs.has(dialog)) return;
  initializedDialogs.add(dialog);

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (!inside) dialog.close();
    });
  }

  dialog.addEventListener('close', () => {
    releaseScrollIfIdle();
    onAfterClose?.();
    const opener = findOpener(dialog);
    opener?.focus({ preventScroll: true });
  });
}

export function openModal(dialog: HTMLDialogElement, trigger?: HTMLElement) {
  rememberOpener(dialog, trigger);
  lockScroll();
  if (!dialog.open) {
    dialog.showModal();
  }
}

export function closeModal(dialog: HTMLDialogElement) {
  if (dialog.open) {
    dialog.close();
  }
}

let activeConfirm: Promise<boolean> | undefined;

/** Keyboard-accessible confirmation modal for destructive or unsaved-leave actions. */
export function confirmAction(options: {
  title: string;
  message: string;
  detail?: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}): Promise<boolean> {
  if (activeConfirm) return Promise.resolve(false);
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const modal = document.createElement('dialog');
  modal.className = 'confirm-dialog';
  modal.setAttribute('closedby', 'closerequest');
  modal.setAttribute('aria-labelledby', 'confirm-title');
  modal.setAttribute('aria-describedby', 'confirm-message');
  modal.innerHTML = `
    <form method="dialog">
      <h2 id="confirm-title">${esc(options.title)}</h2>
      <p id="confirm-message">${esc(options.message)}</p>
      ${options.detail ? `<p class="muted small">${esc(options.detail)}</p>` : ''}
      <div class="form-actions">
        <button value="cancel" autofocus>${esc(options.cancel || '取消')}</button>
        <button value="confirm" class="${options.danger ? 'danger' : 'primary'}">${esc(options.confirm)}</button>
      </div>
    </form>`;

  lockScroll();
  document.body.append(modal);
  activeConfirm = new Promise(resolve =>
    modal.addEventListener(
      'close',
      () => {
        const confirmed = modal.returnValue === 'confirm';
        modal.remove();
        releaseScrollIfIdle();
        activeConfirm = undefined;
        if (opener?.isConnected) opener.focus({ preventScroll: true });
        resolve(confirmed);
      },
      { once: true }
    )
  );
  modal.showModal();
  return activeConfirm;
}
