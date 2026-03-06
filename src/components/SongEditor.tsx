import React, { useState, useEffect, useRef } from 'react';
import { parseTokens, serializeTokens } from '../lib/parseChordPro';
import { SongLineToken } from '../types';

interface SongEditorProps {
  initialSource: string;
  onSave: (source: string) => void;
  onCancel: () => void;
  onDelete?: () => void;
}

export function SongEditor({ initialSource, onSave, onCancel, onDelete }: SongEditorProps) {
  const [source, setSource] = useState(initialSource);
  const [mode, setMode] = useState<'visual' | 'raw'>('visual');
  const [copiedChords, setCopiedChords] = useState<Array<{ line: number; chords: Array<{ name: string; index: number }> }> | null>(null);
  const [copiedSectionName, setCopiedSectionName] = useState<string | null>(null);
  
  const lines = source.split(/\r?\n/);

  const handleLineChange = (index: number, newLine: string) => {
    const newLines = [...lines];
    newLines[index] = newLine;
    setSource(newLines.join('\n'));
  };

  // Find which section a line belongs to
  const getSectionForLineIndex = (lineIndex: number): { name: string; startLine: number; endLine: number } | null => {
    let currentSection: string | null = null;
    let sectionStartLine = -1;

    for (let i = 0; i <= lineIndex; i++) {
      const line = lines[i].trim();
      const sectionMatch = line.match(/^\{\s*section:\s*(.+)\s*\}$/i);
      if (sectionMatch) {
        currentSection = sectionMatch[1].trim();
        sectionStartLine = i;
      }
    }

    if (!currentSection) return null;

    // Find end of section (next section or end of file)
    let endLine = lines.length - 1;
    for (let i = sectionStartLine + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.match(/^\{\s*section:/i)) {
        endLine = i - 1;
        break;
      }
    }

    return { name: currentSection, startLine: sectionStartLine, endLine };
  };

  // Copy all chords from a section
  const handleCopySection = (sectionLineIndex: number) => {
    const section = getSectionForLineIndex(sectionLineIndex);
    if (!section) return;

    const chordData: Array<{ line: number; chords: Array<{ name: string; index: number }> }> = [];

    // Extract chords from each line in the section
    for (let i = section.startLine + 1; i <= section.endLine; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Skip empty lines and directives
      if (trimmed === '' || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        continue;
      }

      // Parse chords from this line
      const tokens = parseTokens(line);
      const chords: Array<{ name: string; index: number }> = [];
      let currentLen = 0;

      tokens.forEach((token) => {
        if (token.chord) {
          chords.push({ name: token.chord, index: currentLen });
        }
        currentLen += token.lyric.length;
      });

      if (chords.length > 0) {
        chordData.push({ line: i - section.startLine - 1, chords }); // Relative line number
      }
    }

    setCopiedChords(chordData);
    setCopiedSectionName(section.name);
  };

  // Paste chords to a section
  const handlePasteSection = (sectionLineIndex: number) => {
    if (!copiedChords) return;

    const section = getSectionForLineIndex(sectionLineIndex);
    if (!section) return;

    const newLines = [...lines];
    let lyricsLineIndex = 0;

    // Apply chords to each line in the target section
    for (let i = section.startLine + 1; i <= section.endLine; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      
      // Skip empty lines and directives
      if (trimmed === '' || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        continue;
      }

      // Find matching chord data for this line
      const chordDataForLine = copiedChords.find(cd => cd.line === lyricsLineIndex);
      if (chordDataForLine) {
        // Get lyrics from current line
        const tokens = parseTokens(line);
        let lyrics = '';
        tokens.forEach(token => {
          lyrics += token.lyric;
        });

        // Apply the copied chords
        const chordsByIndex = new Map<number, string[]>();
        chordDataForLine.chords.forEach(chord => {
          const idx = Math.min(chord.index, lyrics.length);
          const list = chordsByIndex.get(idx) || [];
          list.push(chord.name);
          chordsByIndex.set(idx, list);
        });

        let result = '';
        for (let j = 0; j <= lyrics.length; j++) {
          if (chordsByIndex.has(j)) {
            const chordsAtJ = chordsByIndex.get(j)!;
            chordsAtJ.forEach(c => result += `[${c}]`);
          }
          if (j < lyrics.length) {
            result += lyrics[j];
          }
        }

        newLines[i] = result;
      }

      lyricsLineIndex++;
    }

    setSource(newLines.join('\n'));
  };

  return (
    <div className="song-editor">
      <div className="editor-toolbar">
        <div className="toolbar-group">
            <button onClick={() => setMode(m => m === 'visual' ? 'raw' : 'visual')}>
                {mode === 'visual' ? 'Raw Text' : 'Visual Editor'}
            </button>
        </div>
        <div className="toolbar-group">
            <button className="primary" onClick={() => onSave(source)}>Save Changes</button>
            <button onClick={onCancel}>Cancel</button>
            {onDelete && (
                <button 
                    onClick={onDelete}
                    style={{ backgroundColor: '#fee2e2', color: '#991b1b', borderColor: '#fecaca' }}
                >
                    Delete
                </button>
            )}
        </div>
      </div>
      
      {mode === 'visual' ? (
        <div className="editor-content song">
            {lines.map((line, i) => {
                const trimmed = line.trim();
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    const isSectionDirective = trimmed.match(/^\{\s*section:/i);
                    return (
                        <DirectiveEditor 
                            key={i} 
                            line={line} 
                            lineIndex={i}
                            onChange={(newLine) => handleLineChange(i, newLine)}
                            isSectionDirective={!!isSectionDirective}
                            onCopySection={isSectionDirective ? () => handleCopySection(i) : undefined}
                            onPasteSection={isSectionDirective ? () => handlePasteSection(i) : undefined}
                            hasCopiedChords={copiedChords !== null}
                            copiedSectionName={copiedSectionName}
                        />
                    );
                }
                if (trimmed === '') {
                     return <div key={i} className="line-spacer"></div>;
                }
                return (
                    <LineEditor
                        key={i}
                        line={line}
                        onChange={(newLine) => handleLineChange(i, newLine)}
                    />
                );
            })}
        </div>
      ) : (
        <textarea
            className="raw-editor"
            value={source}
            onChange={e => setSource(e.target.value)}
            spellCheck={false}
        />
      )}

      <style>{`
        .song-editor {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .editor-toolbar {
            display: flex;
            justify-content: space-between;
            gap: 1rem;
            margin-bottom: 1rem;
            position: sticky;
            top: 0;
            background: #f8fafc;
            z-index: 100;
            padding: 10px 0;
            border-bottom: 1px solid #e2e8f0;
        }
        .toolbar-group {
            display: flex;
            gap: 0.5rem;
        }
        .toolbar-group button.primary {
            background: #0f172a;
            color: white;
            border-color: #0f172a;
        }
        .editor-content {
          overflow-x: auto;
        }
        .raw-editor {
            font-family: 'IBM Plex Mono', monospace;
            font-size: 15px;
            background: white;
            color: inherit;
            border: 1px solid #e2e8f0;
            padding: 1rem;
            min-height: 400px;
            resize: vertical;
            border-radius: 8px;
        }
        .line-editor {
          position: relative;
          margin-top: 2.2em; /* Space for chords above */
          margin-bottom: 0.2em;
          min-height: 1.5em;
        }
        .line-spacer {
            height: 1.5em;
        }
        .directive-editor input {
            font-family: inherit;
            font-weight: bold;
            color: #64748b;
            background: transparent;
            border: none;
            padding: 0;
            width: 100%;
            font-size: 0.9em;
        }
        .section-action-button {
          background: #fff;
          border: 1px solid #e2e8f0;
          padding: 0.15rem 0.5rem;
          font-size: 0.7rem;
          color: #64748b;
          border-radius: 6px;
          cursor: pointer;
          white-space: nowrap;
        }
        .section-action-button:hover {
          background: #f8fafc;
          color: #0f172a;
        }
        .chords-layer {
          position: absolute;
          top: -1.6em;
          left: 0;
          width: 100%;
          height: 1.5em;
          pointer-events: auto;
          cursor: text;
        }
        .chord-pill {
          position: absolute;
          font-weight: 700;
          font-size: 0.9em;
          color: #0f172a;
          cursor: grab;
          pointer-events: auto;
          transform: translateX(-50%);
          white-space: nowrap;
          z-index: 10;
          user-select: none;
          line-height: 1;
        }
        .chord-pill:hover {
            color: #fbbf24;
        }
        .chord-pill:active {
          cursor: grabbing;
        }
        .lyrics-input {
          font-family: inherit;
          font-size: inherit;
          width: 100%;
          background: transparent;
          border: none;
          border-bottom: 1px dashed transparent;
          color: inherit;
          padding: 0;
          margin: 0;
          outline: none;
          letter-spacing: 0;
        }
        .lyrics-input:focus {
          background: rgba(0, 0, 0, 0.02);
          border-bottom-color: #cbd5e1;
        }
        .drop-indicator {
          position: absolute;
          top: -1.5em;
          width: 2px;
          height: 2.8em;
          background-color: #fbbf24;
          pointer-events: none;
          z-index: 5;
        }
        .clear-chords-button {
          position: absolute;
          right: 0.25rem;
          top: -0.4rem; /* sit in the chords area */
          background: #fff;
          border: 1px solid #e2e8f0;
          padding: 0.15rem 0.5rem;
          font-size: 0.75rem;
          color: #64748b;
          border-radius: 6px;
          cursor: pointer;
          z-index: 20;
        }
        .clear-chords-button:hover {
          background: #f8fafc;
          color: #0f172a;
        }
      `}</style>
    </div>
  );
}

interface LineEditorProps {
  line: string;
  onChange: (newLine: string) => void;
}

interface DirectiveEditorProps extends LineEditorProps {
  lineIndex: number;
  isSectionDirective: boolean;
  onCopySection?: () => void;
  onPasteSection?: () => void;
  hasCopiedChords: boolean;
  copiedSectionName: string | null;
}

function DirectiveEditor({ line, onChange, isSectionDirective, onCopySection, onPasteSection, hasCopiedChords, copiedSectionName }: DirectiveEditorProps) {
    return (
        <div className="directive-editor" style={{ marginBottom: '0.5em', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input 
                value={line} 
                onChange={e => onChange(e.target.value)} 
                spellCheck={false}
                style={{ flex: 1 }}
            />
            {isSectionDirective && (
                <div style={{ display: 'flex', gap: '0.25rem' }}>
                    <button
                        className="section-action-button"
                        onClick={onCopySection}
                        title="Copy all chords from this section"
                    >
                        Copy
                    </button>
                    {hasCopiedChords && (
                        <button
                            className="section-action-button"
                            onClick={onPasteSection}
                            title={`Paste chords from ${copiedSectionName || 'copied section'}`}
                        >
                            Paste
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

function LineEditor({ line, onChange }: LineEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  
  // Parse line into lyrics and chords with positions
  const tokens = parseTokens(line);
  
  // Calculate lyrics and chord positions
  let lyrics = '';
  const chords: { name: string; index: number; originalTokenIndex: number }[] = [];
  
  let currentLen = 0;
  tokens.forEach((token, i) => {
    if (token.chord) {
      chords.push({ name: token.chord, index: currentLen, originalTokenIndex: i });
    }
    lyrics += token.lyric;
    currentLen += token.lyric.length;
  });

  const handleLyricsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newLyrics = e.target.value;
    reconstructLine(newLyrics, chords);
  };

  const reconstructLine = (newLyrics: string, currentChords: typeof chords) => {
    // Sort chords by index
    const sortedChords = [...currentChords].sort((a, b) => a.index - b.index);
    
    // Group chords by index to handle multiple chords at same position
    const chordsByIndex = new Map<number, string[]>();
    sortedChords.forEach(c => {
      const idx = Math.min(c.index, newLyrics.length); // Clamp to length
      const list = chordsByIndex.get(idx) || [];
      list.push(c.name);
      chordsByIndex.set(idx, list);
    });

    let result = '';
    for (let i = 0; i <= newLyrics.length; i++) {
        if (chordsByIndex.has(i)) {
            const chordsAtI = chordsByIndex.get(i)!;
            chordsAtI.forEach(c => result += `[${c}]`);
        }
        if (i < newLyrics.length) {
            result += newLyrics[i];
        }
    }
    
    onChange(result);
  };

  const handleDragStart = (e: React.DragEvent, chordIndex: number) => {
    e.dataTransfer.setData('chordIndex', chordIndex.toString());
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    if (!containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const newCharIndex = Math.max(0, Math.min(Math.round(offsetX / charWidth), lyrics.length));
    
    setDropIndex(newCharIndex);
  };
  
  const handleDragLeave = () => {
    setDropIndex(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropIndex(null);
    const chordIdxStr = e.dataTransfer.getData('chordIndex');
    if (!chordIdxStr) return;
    
    const chordArrIndex = parseInt(chordIdxStr, 10);
    const chordToMove = chords[chordArrIndex];
    
    if (!containerRef.current) return;
    
    // Calculate new character index based on mouse position
    const rect = containerRef.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    
    const newCharIndex = Math.max(0, Math.min(Math.round(offsetX / charWidth), lyrics.length));
    
    // Update chords array
    const newChords = [...chords];
    newChords[chordArrIndex] = { ...chordToMove, index: newCharIndex };
    
    reconstructLine(lyrics, newChords);
  };

  const handleChordClick = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    const chord = chords[index];
    const newName = prompt('Edit chord (clear to delete):', chord.name);
    if (newName === null) return; // Cancelled
    
    const newChords = [...chords];
    if (newName.trim() === '') {
        // Delete chord
        newChords.splice(index, 1);
    } else {
        newChords[index] = { ...chord, name: newName };
    }
    reconstructLine(lyrics, newChords);
  };

  const handleLayerClick = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const charIndex = Math.max(0, Math.min(Math.round(offsetX / charWidth), lyrics.length));
    
    const name = prompt('Add chord:');
    if (name) {
        const newChords = [...chords, { name, index: charIndex, originalTokenIndex: -1 }];
        reconstructLine(lyrics, newChords);
    }
  };

  // Measure char width on mount
  const [charWidth, setCharWidth] = useState(9.6); // Default for IBM Plex Mono 16px approx
  useEffect(() => {
    const measureSpan = document.createElement('span');
    measureSpan.style.fontFamily = 'IBM Plex Mono, monospace';
    measureSpan.style.fontSize = '16px';
    measureSpan.style.visibility = 'hidden';
    measureSpan.style.position = 'absolute';
    measureSpan.textContent = 'M';
    document.body.appendChild(measureSpan);
    const width = measureSpan.getBoundingClientRect().width;
    setCharWidth(width);
    document.body.removeChild(measureSpan);
  }, []);

  // small left pad equals half a char to ensure first chord is visible
  const leftPad = Math.round(charWidth);

  return (
    <div 
      className="line-editor" 
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropIndex !== null && (
        <div 
            className="drop-indicator" 
            style={{ left: `${dropIndex * charWidth + leftPad}px` }}
        />
      )}
      <div 
        className="chords-layer"
        onClick={handleLayerClick}
        style={{ paddingLeft: `${leftPad}px` }}
      >
        {chords.map((chord, i) => (
          <div
            key={i}
            className="chord-pill"
            style={{ left: `${chord.index * charWidth}px` }}
            draggable
            onDragStart={(e) => handleDragStart(e, i)}
            onClick={(e) => handleChordClick(e, i)}
            title="Drag to move, click to edit"
          >
            {chord.name}
          </div>
        ))}
      </div>
      {/* Clear chords button (right side) */}
      {chords.length > 0 && (
        <button
          className="clear-chords-button"
          onClick={() => reconstructLine(lyrics, [])}
          title="Clear chords in this line"
        >
          Clear chords
        </button>
      )}
      <input
        className="lyrics-input"
        value={lyrics}
        onChange={handleLyricsChange}
        spellCheck={false}
      />
    </div>
  );
}
