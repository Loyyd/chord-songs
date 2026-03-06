import { useEffect, useMemo, useState } from 'react';
import Fuse from 'fuse.js';
import { SongData, SongIndexEntry, SongLineToken } from './types';
import { transposeTokens, transposeChordProSource } from './lib/chords';
import { parseChordPro } from './lib/parseChordPro';
import { SongEditor } from './components/SongEditor';

function SongView({ song, transpose, highlightQuery, isContextSensitive }: { song: SongData; transpose: number; highlightQuery?: string; isContextSensitive?: boolean }) {
  if (!song || !song.sections) return <div className="song">No content</div>;

  const highlightLyric = (lyric: string) => {
    if (!highlightQuery || !isContextSensitive || lyric.trim() === '') {
      return lyric;
    }

    const regex = new RegExp(`(${highlightQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = lyric.split(regex);

    return (
      <>
        {parts.map((part, i) => 
          regex.test(part) ? (
            <mark key={i} style={{ backgroundColor: '#fbbf24', padding: '2px 0' }}>{part}</mark>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </>
    );
  };

  return (
    <div className="song">
      {song.sections.map((section, sectionIdx) => (
        <div key={`${song.id}-section-${sectionIdx}`}>
          <div className="section-title">{section.name}</div>
          {section.lines.map((line, idx) => {
            const transposedTokens = transposeTokens(line.tokens, transpose);
            const hasAnyChord = transposedTokens.some(t => t.chord);
            
            // Merge chord tokens with following lyric tokens
            // e.g., [{chord: "E", lyric: ""}, {chord: null, lyric: "Grace"}] 
            //    -> [{chord: "E", lyric: "Grace"}]
            const mergedTokens: { chord: string | null; lyric: string }[] = [];
            let pendingChord: string | null = null;
            
            for (const token of transposedTokens) {
              if (token.chord && !token.lyric) {
                // Chord with no lyric - save it for the next token
                pendingChord = token.chord;
              } else if (pendingChord) {
                // Apply pending chord to this token
                mergedTokens.push({ chord: pendingChord, lyric: token.lyric || '' });
                pendingChord = null;
              } else {
                mergedTokens.push({ chord: token.chord, lyric: token.lyric || '' });
              }
            }
            // Handle trailing chord with no lyric
            if (pendingChord) {
              mergedTokens.push({ chord: pendingChord, lyric: '' });
            }
            
            return (
              <div className={`line ${hasAnyChord ? 'has-chords' : ''}`} key={`${song.id}-${sectionIdx}-line-${idx}`}>
                {mergedTokens.map((token, i) => {
                  // Calculate minimum width needed for the chord to prevent overlap
                  const chordLength = token.chord ? token.chord.length : 0;
                  const lyricLength = token.lyric.length;
                  // Add padding if chord is longer than lyric to prevent overlap
                  const needsPadding = chordLength > lyricLength;
                  const paddingAmount = needsPadding ? chordLength - lyricLength : 0;
                  
                  return (
                    <span key={i} className="token">
                      {token.chord && <span className="chord">{token.chord}</span>}
                      <span className="lyric">
                        {highlightLyric(token.lyric)}
                        {needsPadding && <span className="chord-spacer">{'\u00A0'.repeat(paddingAmount)}</span>}
                      </span>
                    </span>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<SongIndexEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [song, setSong] = useState<SongData | null>(null);
  const [transpose, setTranspose] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [contextSensitive, setContextSensitive] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [starred, setStarred] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('starred-songs');
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });
  const [autoScroll, setAutoScroll] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(0.15); // Default subtle speed (pixels per frame)

  const refreshIndex = (selectId?: string) => {
    return fetch(`${import.meta.env.BASE_URL}data/songs.index.json`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: SongIndexEntry[]) => {
        setIndex(data);
        if (selectId) {
          setSelectedId(selectId);
        } else if (!selectedId && data.length > 0) {
          setSelectedId(data[0].id);
        }
        return data;
      })
      .catch((err) => console.error('Failed to refresh index:', err));
  };

  const checkAuth = () => {
    if (isAuthenticated) return true;
    const password = window.prompt('Enter password to save changes:');
    if (password === 'truelove') {
      setIsAuthenticated(true);
      return true;
    }
    if (password !== null) {
      alert('Incorrect password');
    }
    return false;
  };

  // Autoscroll effect
  useEffect(() => {
    if (!autoScroll) return;
    
    let animationFrameId: number;
    let accumulatedScroll = 0;
    
    const scroll = () => {
      accumulatedScroll += scrollSpeed;
      
      // Only scroll when we've accumulated at least 1 pixel
      if (accumulatedScroll >= 1) {
        const pixelsToScroll = Math.floor(accumulatedScroll);
        window.scrollBy(0, pixelsToScroll);
        accumulatedScroll -= pixelsToScroll;
      }
      animationFrameId = requestAnimationFrame(scroll);
    };
    
    animationFrameId = requestAnimationFrame(scroll);
    
    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [autoScroll, scrollSpeed]);

  useEffect(() => {
    refreshIndex();
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    if (selectedId.startsWith('new-song-')) return;
    
    fetch(`${import.meta.env.BASE_URL}data/songs/${selectedId}.json`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: SongData) => {
        setSong(data);
        setEditText(data.source ?? '');
        setIsEditing(false);
        setEditError(null);
      })
      .catch((err) => console.error(err));
  }, [selectedId]);

  // Fetch fresh content from backend when editing starts
  useEffect(() => {
    if (isEditing && song?.sourcePath) {
        const filename = song.sourcePath.split('/').pop();
        if (filename) {
            fetch(`/api/songs/${filename}`)
                .then(res => {
                    if (res.ok) return res.json();
                    throw new Error('Failed to fetch from backend');
                })
                .then(data => {
                    if (data.content) {
                        setEditText(data.content);
                    }
                })
                .catch(err => {
                    console.warn("Backend not available or error fetching:", err);
                });
        }
    }
  }, [isEditing, song]);

  const fuse = useMemo(() => {
    if (index.length === 0) return null;
    return new Fuse(index, {
      keys: contextSensitive ? ['title', 'sections'] : ['title'],
      threshold: 0.35,
      includeScore: true
    });
  }, [index, contextSensitive]);

  const results = useMemo(() => {
    if (!fuse || query.trim() === '') return index;
    return fuse.search(query).map((hit) => hit.item);
  }, [fuse, index, query]);

  const sortedResults = useMemo(() => {
    const starredSongs = results.filter(song => starred.has(song.id));
    const unstarredSongs = results.filter(song => !starred.has(song.id));
    return [...starredSongs, ...unstarredSongs];
  }, [results, starred]);

  const toggleStar = (id: string) => {
    setStarred(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      localStorage.setItem('starred-songs', JSON.stringify([...next]));
      return next;
    });
  };

  const toggleFlag = (id: string, currentReviewed: boolean | undefined) => {
    if (!checkAuth()) return;
    const newReviewed = !currentReviewed;
    
    // Optimistically update the index
    setIndex(prev => prev.map(entry => 
      entry.id === id ? { ...entry, reviewed: newReviewed } : entry
    ));
    
    // Also update the current song if it's selected
    if (song && song.id === id) {
      setSong({ ...song, reviewed: newReviewed });
    }
    
    // Sync with backend
    fetch('/api/reviewed', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ song_id: id, reviewed: newReviewed }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          refreshIndex();
        } else {
          console.error('Failed to update reviewed status:', data.error);
          // Revert on error
          setIndex(prev => prev.map(entry => 
            entry.id === id ? { ...entry, reviewed: currentReviewed } : entry
          ));
          if (song && song.id === id) {
            setSong({ ...song, reviewed: currentReviewed });
          }
        }
      })
      .catch((err) => {
        console.error('Failed to sync reviewed status with backend:', err);
        // Revert on error
        setIndex(prev => prev.map(entry => 
          entry.id === id ? { ...entry, reviewed: currentReviewed } : entry
        ));
        if (song && song.id === id) {
          setSong({ ...song, reviewed: currentReviewed });
        }
      });
  };

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setTranspose(0);
  };

  const handleCreateNewSong = () => {
    if (!checkAuth()) return;
    const newSongTemplate = `{title: New Song}
{key: C}

{section: Verse 1}


{section: Chorus}

`;
    
    const newSong: SongData = {
      id: 'new-song-' + Date.now(),
      title: 'New Song',
      key: 'C',
      sections: [],
      source: newSongTemplate,
      sourcePath: null
    };
    
    setSong(newSong);
    setSelectedId(newSong.id);
    setEditText(newSongTemplate);
    setIsEditing(true);
    setEditError(null);
    setTranspose(0);
  };

  const applyEdit = async (source: string = editText) => {
    if (!song) return;
    if (!checkAuth()) return;
    try {
      // Apply transpose to the source before saving
      const transposedSource = transposeChordProSource(source, transpose);
      const parsed = parseChordPro(transposedSource, song.sourcePath ?? 'inline');
      setSong({ ...parsed, id: song.id });
      setEditText(transposedSource);
      setEditError(null);
      setIsEditing(false);
      setTranspose(0); // Reset transpose after applying

      // Save to backend
      try {
        if (song.sourcePath) {
          // Existing song - update it
          const filename = song.sourcePath.split('/').pop();
          if (filename) {
            const response = await fetch(`/api/songs/${filename}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ content: transposedSource }),
            });
            
            if (!response.ok) {
              throw new Error('Failed to save song to backend');
            }
            console.log('Song saved to backend');
            refreshIndex();
          }
        } else {
          // New song - create it
          const response = await fetch(`/api/songs/create`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ content: transposedSource }),
          });
          
          if (!response.ok) {
            throw new Error('Failed to create song on backend');
          }
          
          const result = await response.json();
          console.log('Song created:', result.id);
          
          // Refresh index and select the new song
          refreshIndex(result.id);
        }
      } catch (backendErr) {
        console.error('Backend save failed:', backendErr);
        alert('Failed to save to backend. Is the backend server running?');
      }
    } catch (err) {
      setEditError((err as Error).message ?? 'Failed to parse song');
    }
  };

  const handleDelete = async () => {
    if (!song || !song.sourcePath) {
      // For unsaved new songs, just cancel
      setIsEditing(false);
      setSelectedId(index.length > 0 ? index[0].id : null);
      return;
    }

    if (!window.confirm(`Are you sure you want to delete "${song.title}"?`)) {
      return;
    }

    if (!checkAuth()) return;

    try {
      const filename = song.sourcePath.split('/').pop();
      const response = await fetch(`/api/songs/${filename}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete song');
      }

      // Select another song or clear selection
      const nextIndex = index.filter(s => s.id !== song.id);
      if (nextIndex.length > 0) {
        setSelectedId(nextIndex[0].id);
      } else {
        setSelectedId(null);
        setSong(null);
      }
      
      // Refresh index from server
      refreshIndex();
      
      setIsEditing(false);
      alert('Song deleted successfully');
    } catch (err) {
      alert('Failed to delete song: ' + (err as Error).message);
    }
  };

  return (
    <div className="app-shell">
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
          <h1 style={{ margin: 0 }}>Holy Songs</h1>
          <span 
            onClick={() => !isAuthenticated && checkAuth()}
            style={{ 
              cursor: isAuthenticated ? 'default' : 'pointer',
              fontSize: '20px',
              display: 'flex',
              alignItems: 'center',
              userSelect: 'none'
            }}
            title={isAuthenticated ? 'Authenticated' : 'Login'}
          >
            {isAuthenticated ? (
              <span style={{ color: '#eab308' }}>👑</span>
            ) : (
              <span style={{ color: '#ef4444' }}>🔑</span>
            )}
          </span>
        </div>
        <p style={{ margin: '0 0 12px' }}>Search, view, and transpose songs.</p>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
          <input
            placeholder="Search title or lyrics..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1 }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={contextSensitive}
              onChange={(e) => setContextSensitive(e.target.checked)}
              style={{ width: 'auto', padding: 0, border: 'none', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '14px' }}>Context sensitive</span>
          </label>
          <button 
            onClick={handleCreateNewSong}
            style={{ 
              width: '32px', 
              height: '32px', 
              padding: '0',
              fontSize: '18px',
              fontWeight: 'bold',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
            title="Create new song"
          >
            +
          </button>
        </div>
        <ul className="song-list">
          {sortedResults.map((entry) => (
            <li key={entry.id}>
              <button
                className={entry.id === selectedId ? 'active' : ''}
                onClick={() => handleSelect(entry.id)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 700 }}>{entry.title}</div>
                    <div style={{ fontSize: 13, opacity: 0.75 }}>Key: {entry.key ?? '—'}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <span
                      className={`star-icon ${starred.has(entry.id) ? 'filled' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleStar(entry.id);
                      }}
                      title={starred.has(entry.id) ? 'Unstar song' : 'Star song'}
                    >
                      {starred.has(entry.id) ? '★' : '☆'}
                    </span>
                    <span
                      className={`flag-icon ${entry.reviewed ? 'reviewed' : 'not-reviewed'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFlag(entry.id, entry.reviewed);
                      }}
                      title={entry.reviewed ? 'Mark as not reviewed' : 'Mark as reviewed'}
                    >
                      🚩
                    </span>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        {song ? (
          <>
            <div className="controls" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>{song.title}</h2>
              <span className="chip">Key: {song.key ?? '—'}</span>
              <span className="chip">Transpose: {transpose >= 0 ? `+${transpose}` : transpose}</span>
              <div className="controls">
                <button onClick={() => setTranspose((n) => n - 1)}>-</button>
                <button onClick={() => setTranspose(0)}>Reset</button>
                <button onClick={() => setTranspose((n) => n + 1)}>+</button>
              </div>
              <button onClick={() => setIsEditing((open) => !open)}>
                {isEditing ? 'Close editor' : 'Edit chords/lyrics'}
              </button>
              <button 
                onClick={() => setAutoScroll(!autoScroll)}
                style={{ 
                  background: autoScroll ? '#0f172a' : '#f8fafc',
                  color: autoScroll ? '#f8fafc' : '#0f172a'
                }}
              >
                {autoScroll ? 'Stop scroll' : 'Autoscroll'}
              </button>
              {autoScroll && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexBasis: '100%', marginTop: '8px' }}>
                  <label style={{ fontSize: '14px', whiteSpace: 'nowrap' }}>Speed:</label>
                  <input
                    type="range"
                    min="0.05"
                    max="0.5"
                    step="0.05"
                    value={scrollSpeed}
                    onChange={(e) => setScrollSpeed(parseFloat(e.target.value))}
                    style={{ flex: 1, padding: 0, height: '24px' }}
                  />
                  <span style={{ fontSize: '14px', minWidth: '40px' }}>{scrollSpeed.toFixed(2)}x</span>
                </div>
              )}
            </div>
            {isEditing ? (
              <div className="editor-container">
                <SongEditor
                  initialSource={editText}
                  onSave={applyEdit}
                  onCancel={() => setIsEditing(false)}
                  onDelete={handleDelete}
                />
                {editError && <div className="error">{editError}</div>}
                <div className="note" style={{ marginTop: 8 }}>Edits stay local; rerun build to persist to disk.</div>
              </div>
            ) : (
              <div className="song-container">
                <SongView song={song} transpose={transpose} highlightQuery={query} isContextSensitive={contextSensitive} />
              </div>
            )}
          </>
        ) : (
          <p>Loading song...</p>
        )}
      </div>
    </div>
  );
}
