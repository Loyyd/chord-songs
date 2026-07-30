import type { SongIndexEntry } from '../types';
import type { LiveState } from '../live/liveState';

interface LiveBandProps {
  status: 'idle' | 'authenticating' | 'connecting' | 'connected' | 'error';
  error: string | null;
  state: LiveState;
  isSynchronized: boolean;
  connectedMembers: number;
  knownMembers: number;
  selectedSongId: string | null;
  songs: SongIndexEntry[];
  onConnect: () => void;
  onDisconnect: () => void;
  onAddSong: (songId: string) => void;
  onDeleteEntry: (entryId: string) => void;
  onMoveEntry: (entryId: string, direction: -1 | 1) => void;
  onSelectEntry: (entryId: string) => void;
}

export function LiveBand({
  status,
  error,
  state,
  isSynchronized,
  connectedMembers,
  knownMembers,
  selectedSongId,
  songs,
  onConnect,
  onDisconnect,
  onAddSong,
  onDeleteEntry,
  onMoveEntry,
  onSelectEntry,
}: LiveBandProps) {
  const songsById = new Map(songs.map((song) => [song.id, song]));
  const isConnected = status === 'connected';
  const isBusy = status === 'authenticating' || status === 'connecting';

  return (
    <section className="card live-band" aria-labelledby="live-band-title">
      <div className="live-band-header">
        <div>
          <h2 id="live-band-title">Live set</h2>
          {isConnected ? (
            <div className="live-band-presence" role="status">
              <span className="live-band-presence-dot" aria-hidden="true" />
              {connectedMembers} / {knownMembers} band members connected
            </div>
          ) : (
            <p>Connect to share today&apos;s running order.</p>
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

      {isConnected && (
        <>
          {!isSynchronized ? (
            <div className="live-band-sync" role="status">Adopting the current set…</div>
          ) : (
            <>
              <button
                type="button"
                className="live-band-add"
                disabled={!selectedSongId}
                onClick={() => selectedSongId && onAddSong(selectedSongId)}
              >
                Add selected song
              </button>
              {state.entries.length === 0 ? (
                <p className="live-band-empty">The live set is empty.</p>
              ) : (
                <ol className="live-band-list">
                  {state.entries.map((entry, index) => {
                    const song = songsById.get(entry.songId);
                    const isActive = entry.id === state.activeEntryId;
                    return (
                      <li key={entry.id} className={isActive ? 'active' : ''}>
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
                            aria-label={`Move ${song?.title ?? entry.songId} up`}
                            title="Move up"
                            disabled={index === 0}
                            onClick={() => onMoveEntry(entry.id, -1)}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${song?.title ?? entry.songId} down`}
                            title="Move down"
                            disabled={index === state.entries.length - 1}
                            onClick={() => onMoveEntry(entry.id, 1)}
                          >
                            ↓
                          </button>
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
