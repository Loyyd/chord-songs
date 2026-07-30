import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { SongIndexEntry } from '../types';
import type { LiveState } from '../live/liveState';

interface DragState {
  entryId: string;
  pointerId: number;
  targetIndex: number;
}

interface LiveBandProps {
  status: 'idle' | 'authenticating' | 'connecting' | 'connected' | 'error';
  error: string | null;
  state: LiveState;
  isSynchronized: boolean;
  connectedMembers: number;
  knownMembers: number;
  showSet: boolean;
  children: ReactNode;
  songs: SongIndexEntry[];
  onConnect: () => void;
  onDisconnect: () => void;
  onDeleteEntry: (entryId: string) => void;
  onMoveEntry: (entryId: string, targetIndex: number) => void;
  onSelectEntry: (entryId: string) => void;
}

export function LiveBand({
  status,
  error,
  state,
  isSynchronized,
  connectedMembers,
  knownMembers,
  showSet,
  children,
  songs,
  onConnect,
  onDisconnect,
  onDeleteEntry,
  onMoveEntry,
  onSelectEntry,
}: LiveBandProps) {
  const songsById = new Map(songs.map((song) => [song.id, song]));
  const isConnected = status === 'connected';
  const isBusy = status === 'authenticating' || status === 'connecting';
  const liveListRef = useRef<HTMLOListElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');

  const displayedEntries = [...state.entries];
  if (drag) {
    const currentIndex = displayedEntries.findIndex((entry) => entry.id === drag.entryId);
    if (currentIndex !== -1) {
      const [draggedEntry] = displayedEntries.splice(currentIndex, 1);
      displayedEntries.splice(drag.targetIndex, 0, draggedEntry);
    }
  }

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, entryId: string, index: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ entryId, pointerId: event.pointerId, targetIndex: index });
  };

  const updateDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const list = liveListRef.current;
    if (!list) return;
    const listBounds = list.getBoundingClientRect();
    if (event.clientY < listBounds.top + 48) list.scrollTop -= 16;
    if (event.clientY > listBounds.bottom - 48) list.scrollTop += 16;

    const rows = Array.from(
      list.querySelectorAll<HTMLElement>('[data-live-entry]'),
    ).filter((row) => row.dataset.liveEntry !== drag.entryId);
    const targetIndex = rows.findIndex((row) => {
      const bounds = row.getBoundingClientRect();
      return event.clientY < bounds.top + bounds.height / 2;
    });
    const nextTargetIndex = targetIndex === -1 ? rows.length : targetIndex;
    if (nextTargetIndex !== drag.targetIndex) {
      setDrag({ ...drag, targetIndex: nextTargetIndex });
    }
  };

  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const songTitle = songsById.get(
      state.entries.find((entry) => entry.id === drag.entryId)?.songId ?? '',
    )?.title ?? 'Song';
    const currentIndex = state.entries.findIndex((entry) => entry.id === drag.entryId);
    if (currentIndex !== drag.targetIndex) {
      onMoveEntry(drag.entryId, drag.targetIndex);
      setReorderAnnouncement(songTitle + ' moved to position ' + (drag.targetIndex + 1));
    }
    setDrag(null);
  };

  const moveWithKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    entryId: string,
    index: number,
  ) => {
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (direction === 0) return;
    event.preventDefault();
    const targetIndex = Math.max(0, Math.min(index + direction, state.entries.length - 1));
    if (targetIndex === index) return;
    onMoveEntry(entryId, targetIndex);
    const songTitle = songsById.get(state.entries[index].songId)?.title ?? 'Song';
    setReorderAnnouncement(songTitle + ' moved to position ' + (targetIndex + 1));
  };

  return (
    <section className="card live-band" aria-labelledby="live-band-title">
      <div className="live-band-header">
        <div>
          <div className="brand-heading" id="live-band-title">
            <img
              className="brand-logo"
              src={import.meta.env.BASE_URL + 'logo-black-96.png'}
              alt=""
              aria-hidden="true"
            />
            <h1 className="brand-title" aria-label="Holy Songs">
              <span className="brand-title-holy">Holy</span>
              <span className="brand-title-songs">Songs</span>
            </h1>
          </div>
          {isConnected ? (
            <div className="live-band-presence" role="status">
              <span className="live-band-presence-dot" aria-hidden="true" />
              {connectedMembers} / {knownMembers} band members connected
            </div>
          ) : (
            <p>Search the catalogue or connect to share a running order. <a href="https://auth.bcgen.ie/signup" target="_blank" rel="noreferrer">Create an account</a></p>
          )}
        </div>
        {isConnected ? (
          <button type="button" onClick={onDisconnect}>Disconnect</button>
        ) : (
          <button type="button" className="primary" onClick={onConnect} disabled={isBusy}>
            {isBusy ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>

      {error && <div className="live-band-error" role="alert">{error}</div>}

      {children}

      <p className="sr-only" aria-live="polite">{reorderAnnouncement}</p>

      {isConnected && showSet && (
        <>
          <h2 className="live-set-title">Running order</h2>
          {!isSynchronized ? (
            <div className="live-band-sync" role="status">Adopting the current set…</div>
          ) : (
            <>
              {state.entries.length === 0 ? (
                <p className="live-band-empty">The live set is empty.</p>
              ) : (
                <ol className="live-band-list" ref={liveListRef}>
                  {displayedEntries.map((entry, index) => {
                    const song = songsById.get(entry.songId);
                    const isActive = entry.id === state.activeEntryId;
                    return (
                      <li
                        key={entry.id}
                        data-live-entry={entry.id}
                        className={(isActive ? 'active ' : '') + (drag?.entryId === entry.id ? 'dragging' : '')}
                      >
                        <button
                          type="button"
                          className="live-band-drag"
                          aria-label={'Drag ' + (song?.title ?? entry.songId) + ' to reorder'}
                          title="Drag to reorder; use arrow keys with a keyboard"
                          onPointerDown={(event) => startDrag(event, entry.id, index)}
                          onPointerMove={updateDrag}
                          onPointerUp={finishDrag}
                          onPointerCancel={() => setDrag(null)}
                          onKeyDown={(event) => moveWithKeyboard(event, entry.id, index)}
                        >
                          <span aria-hidden="true">⠿</span>
                        </button>
                        <button
                          type="button"
                          className="live-band-song"
                          onClick={() => onSelectEntry(entry.id)}
                          aria-current={isActive ? 'true' : undefined}
                        >
                          <span>{song?.title ?? entry.songId}</span>
                          {isActive && <small>Current</small>}
                        </button>
                        <div className="live-band-actions">
                          <button
                            type="button"
                            className="danger"
                            aria-label={`Delete ${song?.title ?? entry.songId} from live set`}
                            title="Delete from live set"
                            onClick={() => onDeleteEntry(entry.id)}
                          >
                            ×
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
