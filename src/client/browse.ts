import { transposeTokens } from '../lib/chords';
import type { SongData, SongIndexEntry } from '../types';
import { byId, button, renderMeta, setHidden } from './dom';
import type { LiveBand, LiveBandSnapshot } from './liveBand';
import {
  $autoScroll,
  $query,
  $scrollSpeed,
  $searchResults,
  $selectedSong,
  $selectedSongId,
  $songIndex,
  $starred,
  $transpose,
  $transposeOpen,
} from './state';
import { refreshFromGithub } from './saving';
import { showToast } from './toast';

const songCache = new Map<string, SongData>();
let scrollFrame = 0;
let scrollPrevious: number | null = null;
let scrollRemainder = 0;

function escapePattern(value: string) {
  return value.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

async function fetchIndex() {
  const response = await fetch('/data/songs.index.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Failed to load the song list.');
  const index = await response.json() as SongIndexEntry[];
  $songIndex.set(index);
  const available = new Set(index.map((entry) => entry.id));
  const current = $selectedSongId.get();
  const remembered = sessionStorage.getItem('holy-songs:last-selected-id');
  const initial = current && available.has(current)
    ? current
    : remembered && available.has(remembered)
      ? remembered
      : index[0]?.id ?? null;
  if (initial) selectSong(initial);
}

async function loadSong(id: string, reload = false) {
  const cached = !reload && songCache.get(id);
  if (cached) {
    $selectedSong.set(cached);
    return;
  }
  byId('song-loading').textContent = 'Loading song…';
  setHidden(byId('song-loading'), false);
  setHidden(byId('song-content'), true);
  const response = await fetch('/data/songs/' + encodeURIComponent(id) + '.json', { cache: reload ? 'no-store' : 'default' });
  if (!response.ok) throw new Error('Failed to load song.');
  const song = await response.json() as SongData;
  songCache.set(id, song);
  if ($selectedSongId.get() === id) $selectedSong.set(song);
}

function selectSong(id: string) {
  $selectedSongId.set(id);
  $transpose.set(0);
  void loadSong(id).catch((error: Error) => {
    byId('song-loading').textContent = error.message;
  });
}

function appendHighlighted(target: HTMLElement, lyric: string, query: string) {
  if (!query.trim() || !lyric) {
    target.append(document.createTextNode(lyric));
    return;
  }
  const pattern = new RegExp('(' + escapePattern(query.trim()) + ')', 'gi');
  for (const piece of lyric.split(pattern)) {
    if (piece.toLowerCase() === query.trim().toLowerCase()) {
      const mark = document.createElement('mark');
      mark.textContent = piece;
      target.append(mark);
    } else {
      target.append(document.createTextNode(piece));
    }
  }
}

function renderSong() {
  const song = $selectedSong.get();
  const loading = byId('song-loading');
  const content = byId('song-content');
  if (!song) {
    loading.textContent = 'Select a song.';
    setHidden(loading, false);
    setHidden(content, true);
    return;
  }
  setHidden(loading, true);
  setHidden(content, false);

  const heading = byId('song-heading');
  heading.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = song.title;
  heading.append(title);
  renderMeta(heading, song);

  const root = byId('song-view');
  root.replaceChildren();
  const songNode = document.createElement('div');
  songNode.className = 'song';
  const transpose = $transpose.get();
  const query = $query.get();

  for (const section of song.sections ?? []) {
    const sectionNode = document.createElement('div');
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'section-title';
    sectionTitle.textContent = section.name;
    sectionNode.append(sectionTitle);

    for (const line of section.lines) {
      const tokens = transposeTokens(line.tokens, transpose);
      const merged: Array<{ chord: string | null; lyric: string }> = [];
      let pending: string | null = null;
      for (const token of tokens) {
        if (token.chord && !token.lyric) pending = token.chord;
        else if (pending) {
          merged.push({ chord: pending, lyric: token.lyric || '' });
          pending = null;
        } else merged.push({ chord: token.chord, lyric: token.lyric || '' });
      }
      if (pending) merged.push({ chord: pending, lyric: '' });

      const lineNode = document.createElement('div');
      lineNode.className = 'line' + (tokens.some((token) => token.chord) ? ' has-chords' : '');
      for (const token of merged) {
        const wrapper = document.createElement('span');
        const leading = token.chord ? token.lyric.match(/^\s+/)?.[0] ?? '' : '';
        const lyric = token.chord ? token.lyric.slice(leading.length) : token.lyric;
        if (leading) {
          const whitespace = document.createElement('span');
          whitespace.className = 'lyric';
          whitespace.textContent = leading;
          wrapper.append(whitespace);
        }
        const tokenNode = document.createElement('span');
        tokenNode.className = 'token';
        if (token.chord) {
          const chord = document.createElement('span');
          chord.className = 'chord';
          chord.textContent = token.chord;
          tokenNode.append(chord);
        }
        const lyricNode = document.createElement('span');
        lyricNode.className = 'lyric';
        appendHighlighted(lyricNode, lyric, query);
        if (token.chord && !lyric) {
          const spacer = document.createElement('span');
          spacer.className = 'chord-flow-spacer';
          spacer.ariaHidden = 'true';
          spacer.textContent = token.chord;
          lyricNode.append(spacer);
        } else if (token.chord && token.chord.length > lyric.length) {
          const spacer = document.createElement('span');
          spacer.className = 'chord-spacer';
          spacer.textContent = '\u00a0'.repeat(token.chord.length - lyric.length);
          lyricNode.append(spacer);
        }
        tokenNode.append(lyricNode);
        wrapper.append(tokenNode);
        lineNode.append(wrapper);
      }
      sectionNode.append(lineNode);
    }
    songNode.append(sectionNode);
  }
  root.append(songNode);
}

function startAutoscroll() {
  cancelAnimationFrame(scrollFrame);
  scrollPrevious = null;
  scrollRemainder = 0;
  const tick = (now: number) => {
    if (!$autoScroll.get()) return;
    if (scrollPrevious === null) scrollPrevious = now;
    const elapsed = Math.min((now - scrollPrevious) / 1000, 0.1);
    scrollPrevious = now;
    scrollRemainder += $scrollSpeed.get() * 60 * elapsed;
    if (scrollRemainder >= 1) {
      const pixels = Math.floor(scrollRemainder);
      window.scrollBy(0, pixels);
      scrollRemainder -= pixels;
    }
    scrollFrame = requestAnimationFrame(tick);
  };
  scrollFrame = requestAnimationFrame(tick);
}

function renderToolbar() {
  const transpose = $transpose.get();
  const open = $transposeOpen.get() || transpose !== 0;
  const control = byId('transpose-control');
  control.classList.toggle('open', open);
  byId('transpose-value').textContent = String(transpose);
  byId('transpose-value').setAttribute('aria-label', 'Transpose ' + transpose);
  const scrolling = $autoScroll.get();
  byId('autoscroll-toggle').classList.toggle('active', scrolling);
  byId('autoscroll-toggle').textContent = scrolling ? 'Stop scroll' : 'Autoscroll';
  setHidden(byId('autoscroll-speed'), !scrolling);
  setHidden(byId('floating-autoscroll-stop'), !scrolling);
}

function toggleStar(id: string) {
  const next = new Set($starred.get());
  if (next.has(id)) next.delete(id); else next.add(id);
  $starred.set(next);
}

function renderSearch(live: LiveBandSnapshot, controller: LiveBand) {
  const root = byId<HTMLUListElement>('song-results');
  root.replaceChildren();
  const positions = new Map<string, number>();
  live.state.entries.forEach((entry, index) => {
    if (!positions.has(entry.songId)) positions.set(entry.songId, index + 1);
  });
  const selected = $selectedSongId.get();
  const starred = $starred.get();
  for (const entry of $searchResults.get()) {
    const item = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'song-result-row';
    const main = button('', 'song-result-main' + (entry.id === selected ? ' active' : ''));
    const title = document.createElement('span');
    title.className = 'song-result-title';
    title.textContent = entry.title;
    main.append(title);
    renderMeta(main, entry);
    main.addEventListener('click', () => selectSong(entry.id));
    const actions = document.createElement('div');
    actions.className = 'song-result-actions';
    const position = positions.get(entry.id);
    if (position === undefined) {
      const add = button('+', 'live-add-result');
      add.title = 'Add to set list';
      add.setAttribute('aria-label', 'Add ' + entry.title + ' to set list');
      add.addEventListener('click', () => controller.addSong(entry.id));
      actions.append(add);
    } else {
      const badge = document.createElement('span');
      badge.className = 'live-position-result';
      badge.title = entry.title + ' is number ' + position + ' in the set list';
      badge.textContent = String(position);
      actions.append(badge);
    }
    const star = button(starred.has(entry.id) ? '★' : '☆', 'star-icon' + (starred.has(entry.id) ? ' filled' : ''));
    star.title = starred.has(entry.id) ? 'Unstar song' : 'Star song';
    star.addEventListener('click', () => toggleStar(entry.id));
    actions.append(star);
    row.append(main, actions);
    item.append(row);
    root.append(item);
  }
  setHidden(byId('song-search-empty'), !$query.get().trim() || $searchResults.get().length > 0);
}

interface DragState {
  entryId: string;
  pointerId: number;
  targetIndex: number;
}
let drag: DragState | null = null;

function renderSetList(snapshot: LiveBandSnapshot, controller: LiveBand) {
  const list = byId<HTMLOListElement>('set-list');
  const songs = new Map($songIndex.get().map((song) => [song.id, song]));
  const displayed = [...snapshot.state.entries];
  if (drag) {
    const current = displayed.findIndex((entry) => entry.id === drag?.entryId);
    if (current >= 0) {
      const entry = displayed.splice(current, 1)[0];
      displayed.splice(drag.targetIndex, 0, entry);
    }
  }
  list.replaceChildren();
  for (const [index, entry] of displayed.entries()) {
    const song = songs.get(entry.songId);
    const active = entry.id === snapshot.state.activeEntryId;
    const item = document.createElement('li');
    item.dataset.liveEntry = entry.id;
    item.className = (active ? 'active ' : '') + (drag?.entryId === entry.id ? 'dragging' : '');

    const handle = button('⠿', 'live-band-drag');
    handle.title = 'Drag to reorder; use arrow keys with a keyboard';
    handle.setAttribute('aria-label', 'Drag ' + (song?.title ?? entry.songId) + ' to reorder');
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      drag = { entryId: entry.id, pointerId: event.pointerId, targetIndex: index };
      renderSetList(snapshot, controller);
    });
    handle.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-live-entry]')).filter((row) => row.dataset.liveEntry !== drag?.entryId);
      const target = rows.findIndex((row) => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
      const next = target < 0 ? rows.length : target;
      if (next !== drag.targetIndex) {
        drag.targetIndex = next;
        renderSetList(snapshot, controller);
      }
    });
    const finish = (event: PointerEvent) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const value = drag;
      drag = null;
      const original = snapshot.state.entries.findIndex((candidate) => candidate.id === value.entryId);
      if (original !== value.targetIndex) controller.moveEntry(value.entryId, value.targetIndex);
      byId('reorder-announcement').textContent = (song?.title ?? 'Song') + ' moved to position ' + (value.targetIndex + 1);
      renderSetList(snapshot, controller);
    };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', () => { drag = null; renderSetList(snapshot, controller); });
    handle.addEventListener('keydown', (event) => {
      const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      const target = Math.max(0, Math.min(index + direction, snapshot.state.entries.length - 1));
      if (target !== index) controller.moveEntry(entry.id, target);
    });

    const choose = button('', 'live-band-song');
    const name = document.createElement('span');
    name.textContent = song?.title ?? entry.songId;
    choose.append(name);
    if (active) {
      const current = document.createElement('small');
      current.textContent = 'Current';
      choose.append(current);
      choose.setAttribute('aria-current', 'true');
    }
    choose.addEventListener('click', () => controller.selectEntry(entry.id));
    const remove = button('×', 'live-band-delete');
    remove.title = 'Delete from set list';
    remove.setAttribute('aria-label', 'Delete ' + (song?.title ?? entry.songId) + ' from set list');
    remove.addEventListener('click', () => controller.deleteEntry(entry.id));
    item.append(handle, choose, remove);
    list.append(item);
  }
  setHidden(list, displayed.length === 0);
  setHidden(byId('set-list-empty'), displayed.length !== 0);
}

function renderLive(snapshot: LiveBandSnapshot, controller: LiveBand) {
  const connected = snapshot.status === 'connected';
  const busy = snapshot.status === 'authenticating' || snapshot.status === 'connecting';
  const status = byId('live-status');
  status.className = connected ? 'live-band-presence' : 'live-set-mode';
  status.replaceChildren();
  if (connected) {
    const dot = document.createElement('span');
    dot.className = 'live-band-presence-dot';
    dot.ariaHidden = 'true';
    status.append(dot, document.createTextNode(snapshot.connectedMembers + ' / ' + snapshot.knownMembers + ' band members connected'));
  } else status.textContent = busy ? 'Connecting…' : 'Local';
  const connect = byId<HTMLButtonElement>('connect-button');
  connect.textContent = connected ? 'Disconnect' : busy ? 'Connecting…' : 'Connect';
  connect.disabled = busy;
  connect.onclick = connected ? controller.disconnect : () => { void controller.connect(); };
  const error = byId('live-error');
  error.textContent = snapshot.error ?? '';
  setHidden(error, !snapshot.error);
  setHidden(byId('live-sync'), !connected || snapshot.isSynchronized);
  renderSetList(snapshot, controller);
  renderSearch(snapshot, controller);

  const active = snapshot.state.entries.find((entry) => entry.id === snapshot.state.activeEntryId);
  if (active && active.songId !== $selectedSongId.get()) selectSong(active.songId);
}

export async function initBrowse(controller: LiveBand) {
  let snapshot = controller.$state.get();
  const rerenderSearch = () => renderSearch(snapshot, controller);
  controller.$state.subscribe((next) => {
    snapshot = next;
    renderLive(next, controller);
  });
  $songIndex.subscribe(() => {
    renderSetList(snapshot, controller);
    rerenderSearch();
  });
  $searchResults.subscribe(rerenderSearch);
  $selectedSongId.subscribe(rerenderSearch);
  $starred.subscribe(rerenderSearch);
  $selectedSong.subscribe(renderSong);
  $transpose.subscribe(() => { renderSong(); renderToolbar(); });
  $query.subscribe(() => renderSong());
  $transposeOpen.subscribe(renderToolbar);
  $autoScroll.subscribe((active) => {
    renderToolbar();
    if (active) startAutoscroll(); else cancelAnimationFrame(scrollFrame);
  });

  const search = byId<HTMLInputElement>('song-search');
  search.value = $query.get();
  search.addEventListener('input', () => $query.set(search.value));
  byId('create-song').addEventListener('click', () => window.location.assign('/edit/new'));
  byId('edit-song').addEventListener('click', () => {
    const id = $selectedSongId.get();
    if (id) window.location.assign('/edit/' + encodeURIComponent(id));
  });
  byId('transpose-main').addEventListener('click', () => $transposeOpen.set(true));
  byId('transpose-down').addEventListener('click', () => $transpose.set($transpose.get() - 1));
  byId('transpose-up').addEventListener('click', () => $transpose.set($transpose.get() + 1));
  byId('autoscroll-toggle').addEventListener('click', () => $autoScroll.set(!$autoScroll.get()));
  byId('floating-autoscroll-stop').addEventListener('click', () => $autoScroll.set(false));
  const speed = byId<HTMLInputElement>('speed-slider');
  speed.value = String($scrollSpeed.get());
  speed.addEventListener('input', () => {
    $scrollSpeed.set(Number(speed.value));
    byId('speed-value').textContent = Number(speed.value).toFixed(2) + 'x';
  });
  byId('refresh-songs').addEventListener('click', async () => {
    const button = byId<HTMLButtonElement>('refresh-songs');
    button.disabled = true;
    try {
      const result = await refreshFromGithub();
      songCache.clear();
      await fetchIndex();
      showToast('success', result.changed ? 'Refreshed from GitHub' : 'Already up to date');
    } catch (error) {
      showToast('error', (error as Error).message);
    } finally {
      button.disabled = false;
    }
  });

  renderToolbar();
  await fetchIndex();
}
