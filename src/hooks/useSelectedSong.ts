import { useCallback, useEffect, useState } from 'react';
import { isTemporaryNewSongId } from '../appUtils';
import type { SongData } from '../types';

type EditableSongSource = {
  content: string;
  revision: string;
};

export function useSelectedSong(selectedId: string | null, isEditing: boolean) {
  const [song, setSong] = useState<SongData | null>(null);
  const [editText, setEditText] = useState('');
  const [lastSavedText, setLastSavedText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [isEditSourceLoading, setIsEditSourceLoading] = useState(false);

  const loadSong = useCallback((id: string) => {
    return fetch(`${import.meta.env.BASE_URL}data/songs/${id}.json`)
      .then((res) => res.json())
      .then((data: SongData) => {
        setSong(data);
        setEditText(data.source ?? '');
        setLastSavedText(data.source ?? '');
        setRevision(null);
        setEditError(null);
        return data;
      });
  }, []);

  const setSongSource = useCallback((nextSong: SongData, source: string) => {
    setSong(nextSong);
    setEditText(source);
    setLastSavedText(source);
    setRevision(null);
    setEditError(null);
  }, []);

  const fetchEditableSongSource = useCallback(async (filename: string, signal?: AbortSignal) => {
    const response = await fetch(`/api/songs/${encodeURIComponent(filename)}`, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      throw new Error('Failed to load the latest editable song from the server.');
    }

    const data = await response.json() as Partial<EditableSongSource>;
    if (typeof data.content !== 'string' || typeof data.revision !== 'string') {
      throw new Error('The server returned an incomplete editable song.');
    }
    return data as EditableSongSource;
  }, []);

  const applyEditableSongSource = useCallback((data: EditableSongSource) => {
    setEditText(data.content);
    setLastSavedText(data.content);
    setRevision(data.revision);
    setEditError(null);
  }, []);

  const reloadEditSource = useCallback(async () => {
    const filename = song?.sourcePath?.split('/').pop();
    if (!filename) {
      throw new Error('Failed to determine the song filename.');
    }

    setIsEditSourceLoading(true);
    try {
      const data = await fetchEditableSongSource(filename);
      applyEditableSongSource(data);
      return data;
    } finally {
      setIsEditSourceLoading(false);
    }
  }, [applyEditableSongSource, fetchEditableSongSource, song?.sourcePath]);

  useEffect(() => {
    if (!selectedId) return;
    if (isTemporaryNewSongId(selectedId)) return;
    if (isEditing && song?.id === selectedId && song.sourcePath) return;

    loadSong(selectedId).catch((err) => console.error(err));
  }, [isEditing, loadSong, selectedId]);

  useEffect(() => {
    if (!isEditing || !song?.sourcePath) return;

    const filename = song.sourcePath.split('/').pop();
    if (!filename) return;

    const controller = new AbortController();
    setIsEditSourceLoading(true);
    setRevision(null);
    fetchEditableSongSource(filename, controller.signal)
      .then(applyEditableSongSource)
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.warn('Failed to load editable song:', err);
        setEditError((err as Error).message || 'Failed to load the latest editable song.');
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsEditSourceLoading(false);
        }
      });

    return () => controller.abort();
  }, [applyEditableSongSource, fetchEditableSongSource, isEditing, song?.sourcePath]);

  return {
    song,
    setSong,
    editText,
    setEditText,
    lastSavedText,
    setLastSavedText,
    revision,
    setRevision,
    isEditSourceLoading,
    editError,
    setEditError,
    loadSong,
    setSongSource,
    reloadEditSource,
  };
}
