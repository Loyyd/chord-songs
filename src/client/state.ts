import { atom, computed } from 'nanostores';
import Fuse from 'fuse.js';
import {
  LAST_QUERY_KEY,
  LAST_SELECTED_ID_KEY,
  STARRED_SONGS_KEY,
  type AppRoute,
  parseAppRoute,
} from '../appUtils';
import type { SongData, SongIndexEntry } from '../types';

export interface EditState {
  source: string;
  savedSource: string;
  revision: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  conflict: Error | null;
}

function readStarred() {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(STARRED_SONGS_KEY) ?? '[]'));
  } catch {
    return new Set<string>();
  }
}

export const $route = atom<AppRoute>(parseAppRoute());
export const $songIndex = atom<SongIndexEntry[]>([]);
export const $query = atom(sessionStorage.getItem(LAST_QUERY_KEY) ?? '');
export const $selectedSongId = atom<string | null>(null);
export const $selectedSong = atom<SongData | null>(null);
export const $transpose = atom(0);
export const $transposeOpen = atom(false);
export const $autoScroll = atom(false);
export const $scrollSpeed = atom(0.15);
export const $starred = atom(readStarred());
export const $refreshing = atom(false);
export const $edit = atom<EditState>({
  source: '',
  savedSource: '',
  revision: null,
  loading: false,
  saving: false,
  error: null,
  conflict: null,
});

export const $searchResults = computed(
  [$songIndex, $query, $starred],
  (index, query, starred) => {
    const normalized = query.trim();
    if (!normalized || index.length === 0) return [];
    const results = new Fuse(index, {
      keys: ['title', 'categories', 'sections'],
      threshold: 0.35,
      includeScore: true,
    }).search(normalized).map((hit) => hit.item);
    return [
      ...results.filter((entry) => starred.has(entry.id)),
      ...results.filter((entry) => !starred.has(entry.id)),
    ];
  },
);

$query.subscribe((query) => sessionStorage.setItem(LAST_QUERY_KEY, query));
$selectedSongId.subscribe((id) => {
  if (id && id !== 'new') sessionStorage.setItem(LAST_SELECTED_ID_KEY, id);
});
$starred.subscribe((starred) => {
  localStorage.setItem(STARRED_SONGS_KEY, JSON.stringify([...starred]));
});

export function setRouteFromLocation() {
  $route.set(parseAppRoute());
}
