import { escapeHtml as esc } from './list';

let active: Promise<boolean> | undefined;
/** One keyboard-accessible confirmation surface for navigation and destructive actions. */
export function confirmAction(options: { title: string; message: string; detail?: string; confirm: string; danger?: boolean }): Promise<boolean> {
  if (active) return Promise.resolve(false);
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const modal = document.createElement('dialog');
  modal.className = 'confirm-dialog';
  modal.setAttribute('aria-labelledby', 'confirm-title');
  modal.setAttribute('aria-describedby', 'confirm-message');
  modal.innerHTML = `<form method="dialog"><span class="eyebrow">${options.danger ? '数据操作' : '请确认'}</span><h2 id="confirm-title">${esc(options.title)}</h2><p id="confirm-message">${esc(options.message)}</p>${options.detail ? `<p class="muted small">${esc(options.detail)}</p>` : ''}<div class="form-actions"><button value="cancel" autofocus>取消</button><button value="confirm" class="${options.danger ? 'danger' : 'primary'}">${esc(options.confirm)}</button></div></form>`;
  const overflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  document.body.append(modal);
  active = new Promise(resolve => modal.addEventListener('close', () => {
    const confirmed = modal.returnValue === 'confirm';
    modal.remove();
    document.documentElement.style.overflow = overflow;
    active = undefined;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    resolve(confirmed);
  }, { once: true }));
  modal.showModal();
  return active;
}
