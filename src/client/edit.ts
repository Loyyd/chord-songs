import { isTemporaryNewSongId, NEW_SONG_TEMPLATE } from '../appUtils';
import { CHROMATIC_KEYS, transposeChordProSource, transposeDelta } from '../lib/chords';
import { parseChordPro } from '../lib/parseChordPro';
import { addSongCategoryToSource, normalizeCategoryName, removeSongCategoryFromSource } from '../lib/songCategories';
import type { SongData } from '../types';
import { byId, button, renderMeta, setHidden } from './dom';
import { mountSongEditor, type SongEditorController } from './editorWidget';
import {
  createSong,
  deleteSong,
  pollSyncJob,
  saveExistingSong,
  SongConflictError,
  type SaveResponse,
} from './saving';
import { showToast, syncToast } from './toast';

interface EditorState {
  song: SongData;
  source: string;
  savedSource: string;
  revision: string | null;
  saving: boolean;
  conflict: SongConflictError | null;
  widget: SongEditorController | null;
}

async function getSong(id: string) {
  const response = await fetch('/data/songs/' + encodeURIComponent(id) + '.json');
  if (!response.ok) throw new Error('Failed to load song.');
  return response.json() as Promise<SongData>;
}

async function getLatest(filename: string) {
  const response = await fetch('/api/songs/' + encodeURIComponent(filename), { cache: 'no-store' });
  if (!response.ok) throw new Error('Failed to load the latest editable song from the server.');
  const data = await response.json() as { content?: string; revision?: string };
  if (typeof data.content !== 'string' || typeof data.revision !== 'string') {
    throw new Error('The server returned an incomplete editable song.');
  }
  return { content: data.content, revision: data.revision };
}

function filenameFor(song: SongData) {
  const filename = song.sourcePath?.split('/').pop();
  if (!filename) throw new Error('Failed to determine the song filename.');
  return filename;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

async function settleSync(result: SaveResponse) {
  syncToast(result.sync);
  try {
    const final = await pollSyncJob(result.sync, syncToast);
    if (final) syncToast(final);
  } catch {
    showToast('warning', 'Saved locally, sync status unknown');
  }
}

export async function initEdit(id: string) {
  const title = byId('edit-page-title');
  const ready = byId('edit-ready');
  const loading = byId('edit-loading');
  const error = byId('edit-error');
  const save = byId<HTMLButtonElement>('edit-save');
  const remove = byId<HTMLButtonElement>('edit-delete');
  const categoryForm = byId<HTMLFormElement>('category-form');
  const categoryInput = byId<HTMLInputElement>('category-input');

  let song: SongData;
  let source: string;
  let revision: string | null = null;
  try {
    if (isTemporaryNewSongId(id)) {
      source = NEW_SONG_TEMPLATE;
      song = { ...parseChordPro(source), id, sourcePath: null, source };
    } else {
      song = await getSong(id);
      source = song.source ?? '';
      if (song.sourcePath) {
        const latest = await getLatest(filenameFor(song));
        source = latest.content;
        revision = latest.revision;
      }
    }
  } catch (loadError) {
    loading.textContent = errorMessage(loadError);
    loading.className = 'edit-source-unavailable error';
    return;
  }

  const state: EditorState = {
    song,
    source,
    savedSource: source,
    revision,
    saving: false,
    conflict: null,
    widget: null,
  };

  const setError = (message: string | null) => {
    error.textContent = message ?? '';
    setHidden(error, !message);
  };

  const updateButtons = () => {
    const disabled = state.saving;
    save.disabled = disabled || state.source === state.savedSource || state.conflict !== null;
    save.textContent = state.saving ? 'Saving…' : 'Save Changes';
    remove.disabled = disabled || state.conflict !== null;
    categoryInput.disabled = disabled;
  };

  const updateHeader = () => {
    const parsed = parseChordPro(state.source, state.song.sourcePath ?? 'inline');
    title.replaceChildren();
    const heading = document.createElement('h2');
    heading.textContent = state.song.sourcePath ? 'Edit ' + parsed.title : 'Create Song';
    title.append(heading);
    renderMeta(title, parsed, (category) => {
      state.widget?.setSource(removeSongCategoryFromSource(state.source, category));
    });
    renderTranspose(parsed.key);
    updateButtons();
  };

  const onChange = (next: string) => {
    state.source = next;
    if (!state.conflict) setError(null);
    updateHeader();
  };

  state.widget = mountSongEditor(byId('song-editor'), source, onChange);

  const renderConflict = () => {
    const root = byId('save-conflict');
    root.replaceChildren();
    if (!state.conflict) {
      setHidden(root, true);
      return;
    }
    setHidden(root, false);
    const copy = button('Copy my version');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.source);
        showToast('success', 'Your unsaved version was copied');
      } catch {
        showToast('error', 'Could not copy your unsaved version');
      }
    });
    const reload = button('Reload latest', 'primary');
    reload.addEventListener('click', async () => {
      if (!confirm('Reload the latest server version? Your unsaved edits in this window will be replaced.')) return;
      try {
        const latest = await getLatest(filenameFor(state.song));
        state.revision = latest.revision;
        state.savedSource = latest.content;
        state.conflict = null;
        state.widget?.setSource(latest.content);
        renderConflict();
        showToast('success', 'Loaded the latest version');
      } catch (reloadError) {
        setError(errorMessage(reloadError));
      }
    });
    const message = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = 'Another person saved this song first.';
    const detail = document.createElement('p');
    detail.textContent = 'Your edits are still open here and were not overwritten. Copy them before reloading if you want to merge them into the latest version.';
    message.append(strong, detail);
    const actions = document.createElement('div');
    actions.className = 'save-conflict-actions';
    actions.append(copy, reload);
    root.append(message, actions);
  };

  function renderTranspose(currentKey?: string) {
    const root = byId('edit-transpose');
    root.replaceChildren();
    const label = document.createElement('span');
    label.className = 'edit-transpose-title';
    label.textContent = 'Transpose song';
    const steps = document.createElement('div');
    steps.className = 'edit-transpose-steps';
    const down = button('−');
    const key = document.createElement('span');
    key.className = 'edit-transpose-current';
    key.textContent = currentKey ?? 'No key';
    const up = button('+');
    const apply = (amount: number, target?: string) => {
      if (state.saving) return;
      state.widget?.setSource(transposeChordProSource(state.source, amount, target));
    };
    down.addEventListener('click', () => apply(-1));
    up.addEventListener('click', () => apply(1));
    steps.append(down, key, up);
    const keyLabel = document.createElement('label');
    keyLabel.className = 'edit-transpose-key';
    const keyText = document.createElement('span');
    keyText.textContent = 'Target key';
    const select = document.createElement('select');
    const suffix = currentKey?.match(/^[A-G](?:#|b)?(.*)$/i)?.[1] ?? '';
    if (!currentKey) {
      const option = document.createElement('option');
      option.textContent = 'Choose key';
      option.value = '';
      select.append(option);
    }
    for (const rootKey of CHROMATIC_KEYS) {
      const option = document.createElement('option');
      option.value = rootKey + suffix;
      option.textContent = option.value;
      option.selected = option.value === currentKey;
      select.append(option);
    }
    select.disabled = !currentKey;
    select.addEventListener('change', () => {
      if (currentKey && select.value) apply(transposeDelta(currentKey, select.value), select.value);
    });
    keyLabel.append(keyText, select);
    const hint = document.createElement('span');
    hint.className = 'edit-transpose-hint';
    hint.textContent = 'Updates the source and every chord immediately.';
    root.append(label, steps, keyLabel, hint);
  }

  save.addEventListener('click', async () => {
    if (state.saving || state.source === state.savedSource || state.conflict) return;
    state.saving = true;
    updateButtons();
    try {
      const parsed = parseChordPro(state.source, state.song.sourcePath ?? 'inline');
      let result: SaveResponse;
      if (state.song.sourcePath) {
        if (!state.revision) throw new Error('The latest song revision is still loading. Reload the editor and try again.');
        result = await saveExistingSong(filenameFor(state.song), state.source, state.revision);
        state.revision = result.revision ?? state.revision;
      } else {
        result = await createSong(state.source);
        state.song.sourcePath = result.filename ?? (result.id ?? parsed.id) + '.pro';
        state.song.id = result.id ?? parsed.id;
        state.revision = result.revision ?? null;
      }
      state.savedSource = state.source;
      state.song = { ...parsed, id: result.id ?? parsed.id, sourcePath: state.song.sourcePath, source: state.source };
      const nextPath = '/edit/' + encodeURIComponent(state.song.id);
      if (location.pathname !== nextPath) history.replaceState(null, '', nextPath);
      state.conflict = null;
      renderConflict();
      updateHeader();
      void settleSync(result);
    } catch (saveError) {
      if (saveError instanceof SongConflictError) {
        state.conflict = saveError;
        renderConflict();
        showToast('error', 'Someone else saved this song first. Your edits were not overwritten.');
      } else {
        setError(errorMessage(saveError));
        showToast('error', errorMessage(saveError));
      }
    } finally {
      state.saving = false;
      updateButtons();
    }
  });

  remove.addEventListener('click', async () => {
    if (!state.song.sourcePath) {
      location.assign('/');
      return;
    }
    if (!confirm('Are you sure you want to delete "' + parseChordPro(state.source).title + '"?')) return;
    try {
      if (!state.revision) throw new Error('The latest song revision is still loading.');
      const result = await deleteSong(filenameFor(state.song), state.revision);
      void settleSync(result);
      location.assign('/');
    } catch (deleteError) {
      if (deleteError instanceof SongConflictError) {
        state.conflict = deleteError;
        renderConflict();
      } else setError(errorMessage(deleteError));
      showToast('error', errorMessage(deleteError));
    }
  });

  categoryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const category = normalizeCategoryName(categoryInput.value);
    if (!category) return;
    state.widget?.setSource(addSongCategoryToSource(state.source, category));
    categoryInput.value = '';
  });
  byId('edit-back').addEventListener('click', () => {
    if (state.source !== state.savedSource && !confirm('Leave without saving your changes?')) return;
    location.assign('/');
  });
  window.addEventListener('beforeunload', (event) => {
    if (state.source !== state.savedSource) event.preventDefault();
  });

  setHidden(loading, true);
  setHidden(ready, false);
  renderConflict();
  updateHeader();
}
