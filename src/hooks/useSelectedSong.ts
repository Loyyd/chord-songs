import { useCallback, useEffect, useState } from 'react';
import { isTemporaryNewSongId } from '../appUtils';
import type { SongData } from '../types';

export function useSelectedSong(selectedId: string | null, isEditing: boolean) {
  const [song, setSong] = useState<SongData | null>(null);
  const [editText, setEditText] = useState('');
  const [lastSavedText, setLastSavedText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const loadSong = useCallback((id: string) => {
    return fetch(`${import.meta.env.BASE_URL}data/songs/${id}.json`)
      .then((res) => res.json())
      .then((data: SongData) => {
        setSong(data);
        setEditText(data.source ?? '');
        setLastSavedText(data.source ?? '');
        setEditError(null);
        return data;
      });
  }, []);

  const setSongSource = useCallback((nextSong: SongData, source: string) => {
    setSong(nextSong);
    setEditText(source);
    setLastSavedText(source);
    setEditError(null);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    if (isTemporaryNewSongId(selectedId)) return;

    loadSong(selectedId).catch((err) => console.error(err));
  }, [loadSong, selectedId]);

  useEffect(() => {
    if (isEditing && song?.sourcePath) {
      const filename = song.sourcePath.split('/').pop();
      if (filename) {
        fetch(`/api/songs/${filename}`)
          .then((res) => {
            if (res.ok) return res.json();
            throw new Error('Failed to fetch from backend');
          })
          .then((data) => {
            if (data.content) {
              setEditText(data.content);
              setLastSavedText(data.content);
            }
          })
          .catch((err) => {
            console.warn('Backend not available or error fetching:', err);
          });
      }
    }
  }, [isEditing, song]);

  return {
    song,
    setSong,
    editText,
    setEditText,
    lastSavedText,
    setLastSavedText,
    editError,
    setEditError,
    loadSong,
    setSongSource,
  };
}
