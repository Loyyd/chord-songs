import type { RefObject } from 'react';
import type { SongIndexEntry } from '../types';
import { SongMeta } from './SongMeta';

interface SongListProps {
  entries: SongIndexEntry[];
  selectedId: string | null;
  starred: Set<string>;
  query: string;
  selectedSongButtonRef: RefObject<HTMLButtonElement>;
  onQueryChange: (query: string) => void;
  onCreateNewSong: () => void;
  onSelect: (id: string) => void;
  onToggleStar: (id: string) => void;
  onAddToLive?: (id: string) => void;
}

export function SongList({
  entries,
  selectedId,
  starred,
  query,
  selectedSongButtonRef,
  onQueryChange,
  onCreateNewSong,
  onSelect,
  onToggleStar,
  onAddToLive,
}: SongListProps) {
  return (
    <div className="song-picker">
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
        <input
          placeholder="Search title, category, or lyrics..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          style={{ flex: 1 }}
        />
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
      {query.trim() !== '' && entries.length === 0 && (
        <p className="song-search-empty">No matching songs.</p>
      )}
      <ul className="song-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <div className='song-result-row'>
              <button
                className={'song-result-main' + (entry.id === selectedId ? ' active' : '')}
                ref={entry.id === selectedId ? selectedSongButtonRef : null}
                onClick={() => onSelect(entry.id)}
              >
                <span className='song-result-title'>{entry.title}</span>
                <SongMeta song={entry} />
              </button>
              <div className='song-result-actions'>
                {onAddToLive && (
                  <button
                    type='button'
                    className='live-add-result'
                    onClick={() => onAddToLive(entry.id)}
                    title='Add to live set'
                    aria-label={'Add ' + entry.title + ' to live set'}
                  >
                    +
                  </button>
                )}
                <button
                  type='button'
                  className={'star-icon' + (starred.has(entry.id) ? ' filled' : '')}
                  onClick={() => onToggleStar(entry.id)}
                  title={starred.has(entry.id) ? 'Unstar song' : 'Star song'}
                  aria-label={(starred.has(entry.id) ? 'Unstar ' : 'Star ') + entry.title}
                >
                  {starred.has(entry.id) ? '★' : '☆'}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
