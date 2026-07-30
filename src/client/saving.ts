import { ADMIN_TOKEN_KEY } from '../appUtils';

export type SyncJobStatus = {
  job_id: string;
  status: 'saved_locally' | 'rebuilding' | 'syncing' | 'synced' | 'failed';
  action?: string;
  filename?: string;
  message?: string;
  ok?: boolean | null;
  pushed?: boolean;
};

export type SaveResponse = {
  id?: string;
  filename?: string;
  revision?: string;
  message?: string;
  sync?: SyncJobStatus;
};

type RevisionConflictDetail = {
  code?: string;
  current_revision?: string;
  current_content?: string;
  message?: string;
};

export class SongConflictError extends Error {
  currentRevision?: string;
  currentContent?: string;

  constructor(detail?: RevisionConflictDetail) {
    super(detail?.message ?? 'This song was changed by someone else after you opened it. Your version was not saved.');
    this.name = 'SongConflictError';
    this.currentRevision = detail?.current_revision;
    this.currentContent = detail?.current_content;
  }
}

const done = new Set<SyncJobStatus['status']>(['synced', 'failed']);
let adminToken = localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';

async function responseError(response: Response, fallback: string) {
  try {
    const data = await response.json();
    return data?.detail?.message || data?.detail || data?.message || fallback;
  } catch {
    return fallback;
  }
}

async function conflictError(response: Response) {
  try {
    const detail = (await response.json())?.detail;
    return detail?.code === 'revision_conflict'
      ? new SongConflictError(detail)
      : new Error(detail?.message || detail || 'The song conflicts with another change.');
  } catch {
    return new Error('The song conflicts with another change.');
  }
}

function headers(json = false, token = adminToken) {
  const value: Record<string, string> = {};
  if (json) value['Content-Type'] = 'application/json';
  if (token) value.Authorization = `Bearer ${token}`;
  return value;
}

async function writeFetch(url: string, init: RequestInit = {}, json = false) {
  const request = (token = adminToken) => fetch(url, { ...init, headers: headers(json, token) });
  let response = await request();
  const text = response.status === 403 ? await response.clone().text() : '';
  const needsToken = response.status === 401 || (response.status === 403 && text.includes('Invalid admin token'));
  if (!needsToken) return response;
  if (response.status === 403) {
    adminToken = '';
    localStorage.removeItem(ADMIN_TOKEN_KEY);
  }
  const next = window.prompt(response.status === 403 ? 'Invalid admin token. Enter admin token:' : 'Admin token required:')?.trim();
  if (!next) return response;
  adminToken = next;
  localStorage.setItem(ADMIN_TOKEN_KEY, next);
  return request(next);
}

export async function saveExistingSong(filename: string, content: string, revision: string) {
  const response = await writeFetch(`/api/songs/${encodeURIComponent(filename)}`, {
    method: 'POST',
    body: JSON.stringify({ content, expected_revision: revision }),
  }, true);
  if (response.status === 409) throw await conflictError(response);
  if (!response.ok) throw new Error(await responseError(response, 'Failed to save song.'));
  return response.json() as Promise<SaveResponse>;
}

export async function createSong(content: string) {
  const response = await writeFetch('/api/songs/create', {
    method: 'POST',
    body: JSON.stringify({ content }),
  }, true);
  if (!response.ok) throw new Error(await responseError(response, 'Failed to create song.'));
  return response.json() as Promise<SaveResponse>;
}

export async function deleteSong(filename: string, revision: string) {
  const query = new URLSearchParams({ expected_revision: revision });
  const response = await writeFetch(`/api/songs/${encodeURIComponent(filename)}?${query}`, { method: 'DELETE' });
  if (response.status === 409) throw await conflictError(response);
  if (!response.ok) throw new Error(await responseError(response, 'Failed to delete song.'));
  return response.json() as Promise<SaveResponse>;
}

export async function refreshFromGithub() {
  const response = await writeFetch('/api/refresh', { method: 'POST' });
  if (!response.ok) throw new Error(await responseError(response, 'Failed to refresh from GitHub.'));
  return response.json() as Promise<{ ok: boolean; changed: boolean; message?: string }>;
}

export async function pollSyncJob(initial?: SyncJobStatus, onUpdate?: (status: SyncJobStatus) => void) {
  if (!initial?.job_id) return initial;
  let latest = initial;
  onUpdate?.(latest);
  for (let attempt = 0; attempt < 180 && !done.has(latest.status); attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, attempt < 8 ? 750 : 1500));
    const response = await fetch(`/api/sync-jobs/${latest.job_id}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await responseError(response, 'Failed to check sync status.'));
    latest = await response.json();
    onUpdate?.(latest);
  }
  return latest;
}
