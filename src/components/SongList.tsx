import type { RefObject } from 'react';
import type { SongIndexEntry } from '../types';
import { SongMeta } from './SongMeta';

interface SongListProps {
  entries: SongIndexEntry[];
  selectedId: string | null;
  starred: Set<string>;
  query: string;
  contextSensitive: boolean;
  selectedSongButtonRef: RefObject<HTMLButtonElement>;
  onQueryChange: (query: string) => void;
  onContextSensitiveChange: (enabled: boolean) => void;
  onCreateNewSong: () => void;
  onSelect: (id: string) => void;
  onToggleStar: (id: string) => void;
}

export function SongList({
  entries,
  selectedId,
  starred,
  query,
  contextSensitive,
  selectedSongButtonRef,
  onQueryChange,
  onContextSensitiveChange,
  onCreateNewSong,
  onSelect,
  onToggleStar,
}: SongListProps) {
  return (
    <div className="card">
      <div className="brand-heading">
        <img
          className="brand-logo"
          src={`${import.meta.env.BASE_URL}logo-black-96.png`}
          alt=""
          aria-hidden="true"
        />
        <h1 className="brand-title" aria-label="Holy Songs">
          <span className="brand-title-holy">Holy</span>
          <span className="brand-title-songs">Songs</span>
        </h1>
      </div>
      <p style={{ margin: '0 0 12px' }}>Search, view, and transpose songs.</p>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
        <input
          placeholder="Search title, category, or lyrics..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          style={{ flex: 1 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
          <input
            type="checkbox"
            checked={contextSensitive}
            onChange={(e) => onContextSensitiveChange(e.target.checked)}
            style={{ width: 'auto', padding: 0, border: 'none', cursor: 'pointer' }}
          />
          <span style={{ fontSize: '14px' }}>Context sensitive</span>
        </label>
        <button
          onClick={onCreateNewSong}
          style={{
            width: '32px',
            height: '32px',
            padding: '0',
            fontSize: '18px',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
          title="Create new song"
        >
          +
        </button>
      </div>
      <ul className="song-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <button
              className={entry.id === selectedId ? 'active' : ''}
              ref={entry.id === selectedId ? selectedSongButtonRef : null}
              onClick={() => onSelect(entry.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{entry.title}</div>
                  <SongMeta song={entry} />
                </div>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <span
                    className={`star-icon ${starred.has(entry.id) ? 'filled' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleStar(entry.id);
                    }}
                    title={starred.has(entry.id) ? 'Unstar song' : 'Star song'}
                  >
                    {starred.has(entry.id) ? '★' : '☆'}
                  </span>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
