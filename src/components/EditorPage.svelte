<script lang="ts">
  import { onMount } from 'svelte';
  import { isTemporaryNewSongId, NEW_SONG_TEMPLATE } from '../appUtils';
  import { CHROMATIC_KEYS, transposeChordProSource, transposeDelta } from '../lib/chords';
  import { parseChordPro } from '../lib/parseChordPro';
  import { addSongCategoryToSource, normalizeCategoryName, removeSongCategoryFromSource } from '../lib/songCategories';
  import type { SongData } from '../types';
  import {
    createSong,
    deleteSong,
    pollSyncJob,
    saveExistingSong,
    SongConflictError,
    type SaveResponse,
    type SyncJobStatus,
  } from '../client/saving';
  import SongEditor from './SongEditor.svelte';
  import SongMeta from './SongMeta.svelte';
  import Toast from './Toast.svelte';

  export let id: string;

  let song: SongData | null = null;
  let source = '';
  let savedSource = '';
  let revision: string | null = null;
  let loading = true;
  let loadError = '';
  let error = '';
  let saving = false;
  let conflict: SongConflictError | null = null;
  let categoryInput = '';
  let toastKind: 'success' | 'warning' | 'error' = 'success';
  let toastMessage = '';
  let toastVisible = false;
  let toastTimer: number | null = null;

  $: parsed = parseChordPro(source || NEW_SONG_TEMPLATE, song?.sourcePath ?? 'inline');
  $: dirty = source !== savedSource;
  $: suffix = parsed.key?.match(/^[A-G](?:#|b)?(.*)$/i)?.[1] ?? '';

  function filenameFor(value: SongData) {
    const filename = value.sourcePath?.split('/').pop();
    if (!filename) throw new Error('Failed to determine the song filename.');
    return filename;
  }

  function errorMessage(value: unknown) {
    return value instanceof Error ? value.message : 'Something went wrong.';
  }

  async function getSong(songId: string) {
    const response = await fetch(`/data/songs/${encodeURIComponent(songId)}.json`);
    if (!response.ok) throw new Error('Failed to load song.');
    return response.json() as Promise<SongData>;
  }

  async function getLatest(filename: string) {
    const response = await fetch(`/api/songs/${encodeURIComponent(filename)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to load the latest editable song from the server.');
    const data = await response.json() as { content?: string; revision?: string };
    if (typeof data.content !== 'string' || typeof data.revision !== 'string') {
      throw new Error('The server returned an incomplete editable song.');
    }
    return { content: data.content, revision: data.revision };
  }

  function showToast(kind: typeof toastKind, message: string) {
    toastKind = kind;
    toastMessage = message;
    toastVisible = true;
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastVisible = false;
      toastTimer = null;
    }, kind === 'error' ? 3600 : 2600);
  }

  function syncToast(sync?: SyncJobStatus) {
    if (!sync) return showToast('warning', 'Saved locally, backup status unknown');
    if (sync.status === 'saved_locally') return showToast('success', 'Saved locally, syncing in background');
    if (sync.status === 'rebuilding') return showToast('success', 'Saved locally, rebuilding song data');
    if (sync.status === 'syncing') return showToast('success', 'Song data rebuilt, syncing backup');
    if (sync.status === 'failed' || !sync.ok) return showToast('warning', sync.message?.trim() || 'Saved locally, backup failed');
    showToast('success', sync.pushed ? 'Saved and backed up' : 'Saved locally, no backup changes');
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

  function changeSource(next: string) {
    source = next;
    if (!conflict) error = '';
  }

  function transpose(amount: number, target?: string) {
    if (!saving) changeSource(transposeChordProSource(source, amount, target));
  }

  function addCategory() {
    const category = normalizeCategoryName(categoryInput);
    if (!category) return;
    changeSource(addSongCategoryToSource(source, category));
    categoryInput = '';
  }

  async function save() {
    if (!song || saving || !dirty || conflict) return;
    saving = true;
    error = '';
    try {
      let result: SaveResponse;
      if (song.sourcePath) {
        if (!revision) throw new Error('The latest song revision is still loading. Reload the editor and try again.');
        result = await saveExistingSong(filenameFor(song), source, revision);
        revision = result.revision ?? revision;
      } else {
        result = await createSong(source);
        song.sourcePath = result.filename ?? `${result.id ?? parsed.id}.pro`;
        song.id = result.id ?? parsed.id;
        revision = result.revision ?? null;
      }
      savedSource = source;
      song = { ...parsed, id: result.id ?? parsed.id, sourcePath: song.sourcePath, source };
      const nextPath = `/edit/${encodeURIComponent(song.id)}`;
      if (location.pathname !== nextPath) history.replaceState(null, '', nextPath);
      conflict = null;
      void settleSync(result);
    } catch (value) {
      if (value instanceof SongConflictError) {
        conflict = value;
        showToast('error', 'Someone else saved this song first. Your edits were not overwritten.');
      } else {
        error = errorMessage(value);
        showToast('error', error);
      }
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!song) return;
    if (!song.sourcePath) return void location.assign('/');
    if (!confirm(`Are you sure you want to delete "${parsed.title}"?`)) return;
    try {
      if (!revision) throw new Error('The latest song revision is still loading.');
      const result = await deleteSong(filenameFor(song), revision);
      void settleSync(result);
      location.assign('/');
    } catch (value) {
      if (value instanceof SongConflictError) conflict = value;
      else error = errorMessage(value);
      showToast('error', errorMessage(value));
    }
  }

  async function reloadLatest() {
    if (!song || !confirm('Reload the latest server version? Your unsaved edits in this window will be replaced.')) return;
    try {
      const latest = await getLatest(filenameFor(song));
      revision = latest.revision;
      source = latest.content;
      savedSource = latest.content;
      conflict = null;
      showToast('success', 'Loaded the latest version');
    } catch (value) {
      error = errorMessage(value);
    }
  }

  async function copyUnsaved() {
    try {
      await navigator.clipboard.writeText(source);
      showToast('success', 'Your unsaved version was copied');
    } catch {
      showToast('error', 'Could not copy your unsaved version');
    }
  }

  function leave() {
    if (dirty && !confirm('Leave without saving your changes?')) return;
    location.assign('/');
  }

  onMount(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (source !== savedSource) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    void (async () => {
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
        savedSource = source;
      } catch (value) {
        loadError = errorMessage(value);
      } finally {
        loading = false;
      }
    })();
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      if (toastTimer !== null) window.clearTimeout(toastTimer);
    };
  });
</script>

<main class="edit-page-shell">
  <section class="edit-page-card">
    {#if loading}
      <div class="edit-source-loading">Loading song editor…</div>
    {:else if loadError || !song}
      <div class="edit-source-unavailable error">
        {loadError || 'Failed to load song.'}
        <button type="button" on:click={() => location.reload()}>Try again</button>
      </div>
    {:else}
      <header class="edit-page-header">
        <button type="button" class="edit-cancel-button" on:click={leave}>← Back</button>
        <div class="edit-page-title">
          <h2>{song.sourcePath ? `Edit ${parsed.title}` : 'Create Song'}</h2>
          <SongMeta song={parsed} onRemove={(category) => changeSource(removeSongCategoryFromSource(source, category))} />
        </div>
        <div class="edit-page-actions">
          <form class="category-add-control" on:submit|preventDefault={addCategory}>
            <input bind:value={categoryInput} disabled={saving} placeholder="Add category" aria-label="Add category" />
            <button type="submit" disabled={saving}>Add</button>
          </form>
          <button type="button" class="danger" disabled={saving || !!conflict} on:click={remove}>Delete</button>
          <button type="button" class="primary" disabled={saving || !dirty || !!conflict} on:click={save}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </header>

      <div class="edit-transpose-control">
        <span class="edit-transpose-title">Transpose song</span>
        <div class="edit-transpose-steps">
          <button type="button" on:click={() => transpose(-1)}>−</button>
          <span class="edit-transpose-current">{parsed.key ?? 'No key'}</span>
          <button type="button" on:click={() => transpose(1)}>+</button>
        </div>
        <label class="edit-transpose-key">
          <span>Target key</span>
          <select
            disabled={!parsed.key}
            value={parsed.key ?? ''}
            on:change={(event) => parsed.key && event.currentTarget.value && transpose(transposeDelta(parsed.key, event.currentTarget.value), event.currentTarget.value)}
          >
            {#if !parsed.key}<option value="">Choose key</option>{/if}
            {#each CHROMATIC_KEYS as rootKey}
              <option value={rootKey + suffix}>{rootKey + suffix}</option>
            {/each}
          </select>
        </label>
        <span class="edit-transpose-hint">Updates the source and every chord immediately.</span>
      </div>

      {#if conflict}
        <div class="save-conflict">
          <div>
            <strong>Another person saved this song first.</strong>
            <p>Your edits are still open here and were not overwritten. Copy them before reloading if you want to merge them into the latest version.</p>
          </div>
          <div class="save-conflict-actions">
            <button type="button" on:click={copyUnsaved}>Copy my version</button>
            <button type="button" class="primary" on:click={reloadLatest}>Reload latest</button>
          </div>
        </div>
      {/if}

      {#if error}<p class="error edit-page-note">{error}</p>{/if}
      <SongEditor {source} onChange={changeSource} />
    {/if}
  </section>
</main>

<Toast kind={toastKind} message={toastMessage} visible={toastVisible} />
