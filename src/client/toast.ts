import type { SyncJobStatus } from './saving';
import { byId } from './dom';

let timeout: number | null = null;

export function showToast(kind: 'success' | 'warning' | 'error', message: string) {
  const toast = byId<HTMLDivElement>('save-toast');
  toast.className = `save-toast visible ${kind}`;
  toast.setAttribute('aria-label', message);
  const icon = toast.querySelector<HTMLElement>('.save-toast-icon');
  const label = toast.querySelector<HTMLElement>('.save-toast-label');
  if (icon) icon.textContent = kind === 'success' ? '✓' : kind === 'error' ? '×' : '!';
  if (label) label.textContent = message;
  if (timeout !== null) window.clearTimeout(timeout);
  timeout = window.setTimeout(() => {
    toast.classList.remove('visible');
    timeout = null;
  }, kind === 'error' ? 3600 : 2600);
}

export function syncToast(sync?: SyncJobStatus) {
  if (!sync) return showToast('warning', 'Saved locally, backup status unknown');
  if (sync.status === 'saved_locally') return showToast('success', 'Saved locally, syncing in background');
  if (sync.status === 'rebuilding') return showToast('success', 'Saved locally, rebuilding song data');
  if (sync.status === 'syncing') return showToast('success', 'Song data rebuilt, syncing backup');
  if (sync.status === 'failed' || !sync.ok) {
    return showToast('warning', sync.message?.trim() || 'Saved locally, GitHub backup failed');
  }
  showToast('success', sync.pushed ? 'Saved and backed up' : 'Saved locally, no backup changes');
}
