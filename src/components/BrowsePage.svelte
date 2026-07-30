<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Fuse from 'fuse.js';
  import { LAST_QUERY_KEY, LAST_SELECTED_ID_KEY, STARRED_SONGS_KEY } from '../appUtils';
  import { createLiveBand } from '../client/liveBand';
  import { refreshFromGithub } from '../client/saving';
  import type { LiveBandSnapshot } from '../client/liveBand';
  import type { SongData, SongIndexEntry } from '../types';
  import SongMeta from './SongMeta.svelte';
  import SongView from './SongView.svelte';
  import Toast from './Toast.svelte';

  const live = createLiveBand();
  const liveStore = live.$state;

  let index: SongIndexEntry[] = [];
  let selectedId: string | null = null;
  let song: SongData | null = null;
  let query = '';
  let transpose = 0;
  let transposeOpen = false;
  let autoScroll = false;
  let scrollSpeed = 0.15;
  let refreshing = false;
  let starred = new Set<string>();
  let loadingMessage = 'Loading song…';
  let listElement: HTMLOListElement;
  let acceptingSongDrop = false;
  let reorderAnnouncement = '';
  let scrollFrame = 0;
  let toastTimer = 0;
  let toast = { visible: false, kind: 'success' as 'success' | 'warning' | 'error', message: '' };

  type DragState = { entryId: string; pointerId: number; targetIndex: number };
  let drag: DragState | null = null;

  $: fuse = index.length
    ? new Fuse(index, { keys: ['title', 'categories', 'sections'], threshold: 0.35, includeScore: true })
    : null;
  $: rawResults = fuse && query.trim() ? fuse.search(query).map((hit) => hit.item) : [];
  $: results = [
    ...rawResults.filter((entry) => starred.has(entry.id)),
    ...rawResults.filter((entry) => !starred.has(entry.id)),
  ];
  $: positions = new Map(
    $liveStore.state.entries.map((entry, position) => [entry.songId, position + 1] as const),
  );
  $: connected = $liveStore.status === 'connected';
  $: busy = $liveStore.status === 'authenticating' || $liveStore.status === 'connecting';
  $: displayedEntries = reorderEntries($liveStore.state.entries, drag);
  $: activeEntry = $liveStore.state.entries.find((entry) => entry.id === $liveStore.state.activeEntryId);
  $: if (activeEntry && activeEntry.songId !== selectedId && index.some((entry) => entry.id === activeEntry?.songId)) {
    void selectSong(activeEntry.songId);
  }

  function reorderEntries(entries: LiveBandSnapshot['state']['entries'], currentDrag: DragState | null) {
    const displayed = [...entries];
    if (!currentDrag) return displayed;
    const current = displayed.findIndex((entry) => entry.id === currentDrag.entryId);
    if (current < 0) return displayed;
    const [entry] = displayed.splice(current, 1);
    displayed.splice(currentDrag.targetIndex, 0, entry);
    return displayed;
  }

  function notify(kind: 'success' | 'warning' | 'error', message: string) {
    window.clearTimeout(toastTimer);
    toast = { visible: true, kind, message };
    toastTimer = window.setTimeout(() => {
      toast = { ...toast, visible: false };
    }, kind === 'error' ? 3600 : 2600);
  }

  async function loadIndex() {
    const response = await fetch('/data/songs.index.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to load the song list.');
    index = await response.json() as SongIndexEntry[];
    const remembered = sessionStorage.getItem(LAST_SELECTED_ID_KEY);
    const initial = selectedId && index.some((entry) => entry.id === selectedId)
      ? selectedId
      : remembered && index.some((entry) => entry.id === remembered)
        ? remembered
        : index[0]?.id ?? null;
    if (initial) await selectSong(initial);
  }

  async function selectSong(id: string) {
    selectedId = id;
    transpose = 0;
    transposeOpen = false;
    sessionStorage.setItem(LAST_SELECTED_ID_KEY, id);
    loadingMessage = 'Loading song…';
    song = null;
    try {
      const response = await fetch('/data/songs/' + encodeURIComponent(id) + '.json');
      if (!response.ok) throw new Error('Failed to load song.');
      if (selectedId === id) song = await response.json() as SongData;
    } catch (error) {
      loadingMessage = (error as Error).message;
    }
  }

  function toggleStar(id: string) {
    const next = new Set(starred);
    if (next.has(id)) next.delete(id); else next.add(id);
    starred = next;
    localStorage.setItem(STARRED_SONGS_KEY, JSON.stringify([...next]));
  }

  function toggleAutoscroll() {
    autoScroll = !autoScroll;
    if (!autoScroll) {
      cancelAnimationFrame(scrollFrame);
      return;
    }
    let previous: number | null = null;
    let remainder = 0;
    const tick = (timestamp: number) => {
      if (!autoScroll) return;
      if (previous === null) previous = timestamp;
      const elapsed = Math.min((timestamp - previous) / 1000, 0.1);
      previous = timestamp;
      remainder += scrollSpeed * 60 * elapsed;
      if (remainder >= 1) {
        const pixels = Math.floor(remainder);
        window.scrollBy(0, pixels);
        remainder -= pixels;
      }
      scrollFrame = requestAnimationFrame(tick);
    };
    scrollFrame = requestAnimationFrame(tick);
  }

  function startSetDrag(event: PointerEvent, entryId: string, listIndex: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag = { entryId, pointerId: event.pointerId, targetIndex: listIndex };
  }

  function updateSetDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId || !listElement) return;
    const rows = Array.from(listElement.querySelectorAll<HTMLElement>('[data-live-entry]'))
      .filter((row) => row.dataset.liveEntry !== drag?.entryId);
    const target = rows.findIndex((row) => {
      const bounds = row.getBoundingClientRect();
      return event.clientY < bounds.top + bounds.height / 2;
    });
    const next = target < 0 ? rows.length : target;
    if (next !== drag.targetIndex) drag = { ...drag, targetIndex: next };
  }

  function finishSetDrag(event: PointerEvent, title: string) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const finished = drag;
    drag = null;
    const original = $liveStore.state.entries.findIndex((entry) => entry.id === finished.entryId);
    if (original !== finished.targetIndex) live.moveEntry(finished.entryId, finished.targetIndex);
    reorderAnnouncement = title + ' moved to position ' + (finished.targetIndex + 1);
  }

  function moveWithKeyboard(event: KeyboardEvent, entryId: string, listIndex: number, title: string) {
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(listIndex + direction, $liveStore.state.entries.length - 1));
    if (target === listIndex) return;
    live.moveEntry(entryId, target);
    reorderAnnouncement = title + ' moved to position ' + (target + 1);
  }

  function startSearchDrag(event: DragEvent, entry: SongIndexEntry) {
    event.dataTransfer?.setData('application/x-holy-songs-song', entry.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  }

  function acceptsSong(event: DragEvent) {
    return Array.from(event.dataTransfer?.types ?? []).includes('application/x-holy-songs-song');
  }

  function dragOverSet(event: DragEvent) {
    if (!acceptsSong(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    acceptingSongDrop = true;
  }

  function dropOnSet(event: DragEvent) {
    const songId = event.dataTransfer?.getData('application/x-holy-songs-song');
    acceptingSongDrop = false;
    if (!songId) return;
    event.preventDefault();
    live.addSong(songId);
    void selectSong(songId);
  }

  async function refresh() {
    refreshing = true;
    try {
      const response = await refreshFromGithub();
      await loadIndex();
      notify('success', response.changed ? 'Refreshed from GitHub' : 'Already up to date');
    } catch (error) {
      notify('error', (error as Error).message);
    } finally {
      refreshing = false;
    }
  }

  onMount(() => {
    query = sessionStorage.getItem(LAST_QUERY_KEY) ?? '';
    try {
      starred = new Set(JSON.parse(localStorage.getItem(STARRED_SONGS_KEY) ?? '[]'));
    } catch {
      starred = new Set();
    }
    void loadIndex().catch((error) => {
      loadingMessage = (error as Error).message;
    });
  });

  $: if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(LAST_QUERY_KEY, query);

  onDestroy(() => {
    live.destroy();
    cancelAnimationFrame(scrollFrame);
    window.clearTimeout(toastTimer);
  });
</script>

<svelte:window on:dragend={() => acceptingSongDrop = false} on:drop={() => acceptingSongDrop = false} />

<main class="app-shell">
  <div class="sidebar-stack">
    <section class:accepting-song-drop={acceptingSongDrop} class="card live-band" aria-labelledby="live-band-title">
      <div class="live-band-header">
        <div class="brand-heading" id="live-band-title">
          <img class="brand-logo" src="/logo-black-96.png" alt="" aria-hidden="true" />
          <h1 class="brand-title" aria-label="Holy Songs">
            <span class="brand-title-holy">Holy</span>
            <span class="brand-title-songs">Songs</span>
          </h1>
        </div>
        <p>Build your set list locally. Connect when you are ready to share it.</p>
      </div>

      {#if $liveStore.error}<div class="live-band-error" role="alert">{$liveStore.error}</div>{/if}
      <p class="sr-only" aria-live="polite">{reorderAnnouncement}</p>

      <div
        class="live-set-drop-zone"
        role="region"
        aria-label="Set list drop zone"
        on:dragover={dragOverSet}
        on:dragleave={(event) => {
          if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) acceptingSongDrop = false;
        }}
        on:drop={dropOnSet}
      >
        <div class="live-set-header">
          <div>
            <h2 class="live-set-title">Set list</h2>
            {#if connected}
              <div class="live-band-presence" role="status">
                <span class="live-band-presence-dot" aria-hidden="true"></span>
                {$liveStore.connectedMembers} / {$liveStore.knownMembers} band members connected
              </div>
            {:else}
              <div class="live-set-mode">{busy ? 'Connecting…' : 'Local'}</div>
            {/if}
          </div>
          {#if connected}
            <button type="button" on:click={live.disconnect}>Disconnect</button>
          {:else}
            <button type="button" class="primary" on:click={() => void live.connect()} disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          {/if}
        </div>

        {#if connected && !$liveStore.isSynchronized}
          <div class="live-band-sync" role="status">Syncing the shared set list…</div>
        {:else if displayedEntries.length === 0}
          <p class="live-band-empty">The set list is empty.</p>
        {:else}
          <ol class="live-band-list" bind:this={listElement}>
            {#each displayedEntries as entry, listIndex (entry.id)}
              {@const entrySong = index.find((candidate) => candidate.id === entry.songId)}
              {@const title = entrySong?.title ?? entry.songId}
              <li
                data-live-entry={entry.id}
                class:active={entry.id === $liveStore.state.activeEntryId}
                class:dragging={drag?.entryId === entry.id}
              >
                <button
                  type="button"
                  class="live-band-drag"
                  aria-label="Drag {title} to reorder"
                  title="Drag to reorder; use arrow keys with a keyboard"
                  on:pointerdown={(event) => startSetDrag(event, entry.id, listIndex)}
                  on:pointermove={updateSetDrag}
                  on:pointerup={(event) => finishSetDrag(event, title)}
                  on:pointercancel={() => drag = null}
                  on:keydown={(event) => moveWithKeyboard(event, entry.id, listIndex, title)}
                ><span aria-hidden="true">⠿</span></button>
                <button
                  type="button"
                  class="live-band-song"
                  aria-current={entry.id === $liveStore.state.activeEntryId ? 'true' : undefined}
                  on:click={() => live.selectEntry(entry.id)}
                >
                  <span>{title}</span>
                  {#if entry.id === $liveStore.state.activeEntryId}<small>Current</small>{/if}
                </button>
                <button
                  type="button"
                  class="live-band-delete"
                  aria-label="Delete {title} from set list"
                  title="Delete from set list"
                  on:click={() => live.deleteEntry(entry.id)}
                >×</button>
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      <div class="song-picker">
        <div class="song-search-controls">
          <input
            placeholder="Search title, category, or lyrics..."
            bind:value={query}
            autocomplete="off"
          />
          <button
            type="button"
            class="create-song-button"
            title="Create new song"
            aria-label="Create new song"
            on:click={() => location.assign('/edit/new')}
          >+</button>
        </div>
        {#if query.trim() && results.length === 0}
          <p class="song-search-empty">No matching songs.</p>
        {/if}
        <ul class="song-list">
          {#each results as entry (entry.id)}
            {@const position = positions.get(entry.id)}
            <li>
              <div class:active={entry.id === selectedId} class="song-result-row">
                <button
                  type="button"
                  class="song-result-main"
                  draggable={position === undefined}
                  title={position === undefined ? 'Open song; drag to add it to the set list' : 'Open song'}
                  on:click={() => void selectSong(entry.id)}
                  on:dragstart={(event) => startSearchDrag(event, entry)}
                >
                  <span class="song-result-title">{entry.title}</span>
                  <SongMeta song={entry} />
                </button>
                <div class="song-result-actions">
                  {#if position === undefined}
                    <button
                      type="button"
                      class="live-add-result"
                      title="Add to set list"
                      aria-label="Add {entry.title} to set list"
                      on:click={() => live.addSong(entry.id)}
                    >+</button>
                  {:else}
                    <span class="live-position-result" title="{entry.title} is number {position} in the set list">
                      <span class="sr-only">Position in set list: </span>{position}
                    </span>
                  {/if}
                  <button
                    type="button"
                    class:filled={starred.has(entry.id)}
                    class="star-icon"
                    title={starred.has(entry.id) ? 'Unstar song' : 'Star song'}
                    aria-label={(starred.has(entry.id) ? 'Unstar ' : 'Star ') + entry.title}
                    on:click={() => toggleStar(entry.id)}
                  >{starred.has(entry.id) ? '★' : '☆'}</button>
                </div>
              </div>
            </li>
          {/each}
        </ul>
      </div>
    </section>
  </div>

  <section class="card">
    {#if song}
      <div class="song-header">
        <div class="song-heading">
          <h2>{song.title}</h2>
          <SongMeta {song} />
        </div>
        <div class="song-actions">
          <div class:open={transposeOpen || transpose !== 0} class="transpose-control">
            <button class="transpose-main" title="Transpose" aria-label="Open transpose controls" on:click={() => transposeOpen = true}>
              <span class="transpose-label-full">Transpose</span>
              <span class="transpose-label-short">Tr.</span>
            </button>
            <button class="transpose-step" title="Transpose down" aria-label="Transpose down" tabindex="-1" on:click={() => transpose -= 1}>−</button>
            <span class="transpose-value" aria-label="Transpose {transpose}">{transpose}</span>
            <button class="transpose-step" title="Transpose up" aria-label="Transpose up" tabindex="-1" on:click={() => transpose += 1}>+</button>
          </div>
          <button type="button" on:click={() => location.assign('/edit/' + encodeURIComponent(song!.id))}>Edit</button>
          <button class:active={autoScroll} type="button" on:click={toggleAutoscroll}>
            {autoScroll ? 'Stop scroll' : 'Autoscroll'}
          </button>
          <button class="refresh-button" type="button" title="Refresh from GitHub" aria-label="Refresh from GitHub" disabled={refreshing} on:click={() => void refresh()}>
            <img src="/refresh.png" alt="" aria-hidden="true" />
          </button>
        </div>
        {#if autoScroll}
          <div class="autoscroll-speed">
            <label for="speed-slider">Speed:</label>
            <input id="speed-slider" type="range" min="0.05" max="0.5" step="0.01" bind:value={scrollSpeed} class="speed-slider" />
            <span class="speed-value">{Number(scrollSpeed).toFixed(2)}x</span>
          </div>
        {/if}
      </div>
      <div class="song-container"><SongView {song} {transpose} {query} /></div>
    {:else}
      <p>{loadingMessage}</p>
    {/if}
  </section>

  {#if autoScroll}
    <button class="floating-autoscroll-stop" type="button" aria-label="Disable autoscroll" on:click={toggleAutoscroll}>Stop scroll</button>
  {/if}
</main>

<Toast {...toast} />
