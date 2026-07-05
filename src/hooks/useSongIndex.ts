import { useCallback, useEffect, useState } from 'react';
import { LAST_SELECTED_ID_KEY, parseAppRoute } from '../appUtils';
import type { SongIndexEntry } from '../types';

export function useSongIndex() {
  const [index, setIndex] = useState<SongIndexEntry[]>([]);

  const refreshIndex = useCallback((selectId?: string) => {
    return fetch(`${import.meta.env.BASE_URL}data/songs.index.json`)
      .then((res) => res.json())
      .then((data: unknown) => {
        const indexData = Array.isArray(data) ? (data as SongIndexEntry[]) : [];
        setIndex(indexData);
        return { data: indexData, selectId };
      })
      .catch((err) => {
        console.error('Failed to refresh index:', err);
        return { data: [] as SongIndexEntry[], selectId };
      });
  }, []);

  const getInitialSelectedId = useCallback((data: SongIndexEntry[], currentSelectedId: string | null) => {
    if (currentSelectedId) return currentSelectedId;

    const savedSelectedId = sessionStorage.getItem(LAST_SELECTED_ID_KEY);
    return savedSelectedId && data.some((entry) => entry.id === savedSelectedId) ? savedSelectedId : data[0]?.id ?? null;
  }, []);

  const shouldRestoreSelection = useCallback(() => parseAppRoute().mode !== 'edit', []);

  useEffect(() => {
    refreshIndex();
  }, [refreshIndex]);

  return {
    index,
    setIndex,
    refreshIndex,
    getInitialSelectedId,
    shouldRestoreSelection,
  };
}
