import React, { useState, useEffect, useRef } from 'react';
import { parseTokens } from '../lib/parseChordPro';
import { syncChordEditWithLine } from '../lib/chordEditing';
import type { ChordEditState } from '../lib/chordEditing';

interface SongEditorProps {
  source: string;
  onChange: (source: string) => void;
}

export function SongEditor({ source, onChange }: SongEditorProps) {
  const [copiedChords, setCopiedChords] = useState<Array<{ line: number; chords: Array<{ name: string; index: number }> }> | null>(null);
  const [copiedSectionName, setCopiedSectionName] = useState<string | null>(null);
  
  const lines = source.split(/\r?\n/);

  const handleLineChange = (index: number, newLine: string) => {
    const newLines = [...lines];
    newLines[index] = newLine;
    onChange(newLines.join('\n'));
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

    onChange(newLines.join('\n'));
  };

  return (
    <div className="song-editor">
      <div className="editor-split">
        <section className="editor-pane raw-pane" aria-label="Raw ChordPro source">
          <div className="editor-pane-heading">Raw text</div>
          <textarea
              className="raw-editor"
              value={source}
              onChange={e => onChange(e.target.value)}
              spellCheck={false}
          />
        </section>
        <section className="editor-pane visual-pane" aria-label="Visual song editor">
          <div className="editor-pane-heading">Visual editor</div>
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
        </section>
      </div>

      <style>{`
        .song-editor {
          min-width: 0;
        }
        .editor-split {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 1rem;
          align-items: stretch;
        }
        .editor-pane {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
        }
        .editor-pane-heading {
          color: var(--brand-blue-soft);
          font-size: 0.82rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0;
        }
        .editor-content {
          overflow-x: auto;
          min-height: 560px;
          max-height: calc(100vh - 245px);
          padding: 1rem;
          border: 1px solid var(--border-soft);
          border-radius: 8px;
          background: white;
        }
        .visual-pane .editor-content {
          overflow-y: auto;
        }
        .raw-editor {
            font-family: 'IBM Plex Mono', monospace;
            font-size: 15px;
            background: white;
            color: inherit;
            border: 1px solid var(--border-soft);
            padding: 1rem;
            min-height: 560px;
            max-height: calc(100vh - 245px);
            resize: none;
            border-radius: 8px;
            line-height: 1.45;
            width: 100%;
            flex: 1;
            overflow: auto;
            white-space: pre;
        }
        @media (max-width: 900px) {
          .editor-split {
            grid-template-columns: 1fr;
          }
          .raw-editor,
          .editor-content {
            min-height: 380px;
            max-height: none;
          }
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
            color: var(--brand-gold);
            background: transparent;
            border: none;
            padding: 0;
            width: 100%;
            font-size: 0.9em;
        }
        .section-action-button {
          background: #fff;
          border: 1px solid var(--border-soft);
          padding: 0.15rem 0.5rem;
          font-size: 0.7rem;
          color: var(--brand-blue);
          border-radius: 6px;
          cursor: pointer;
          white-space: nowrap;
        }
        .section-action-button:hover {
          background: rgba(216, 152, 16, 0.13);
          color: var(--brand-blue);
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
          color: var(--brand-blue);
          cursor: grab;
          pointer-events: auto;
          transform: translateX(-50%);
          white-space: nowrap;
          z-index: 10;
          user-select: none;
          line-height: 1;
          background: transparent;
          border: 1px solid transparent;
          border-radius: 4px;
          padding: 0.08rem 0.15rem;
          font-family: inherit;
        }
        .chord-pill:hover,
        .chord-pill:focus-visible,
        .chord-pill.is-selected,
        .chord-pill.is-touch-dragging {
            color: var(--brand-gold);
            background: rgba(216, 152, 16, 0.11);
            border-color: rgba(216, 152, 16, 0.32);
            outline: none;
        }
        .chord-pill:active {
          cursor: grabbing;
        }
        .chord-edit-input {
          position: absolute;
          top: -0.2rem;
          z-index: 30;
          transform: translateX(-50%);
          width: 4.25rem;
          min-width: 3.25rem;
          max-width: 5.25rem;
          border: 1px solid var(--brand-gold);
          border-radius: 5px;
          background: white;
          color: var(--brand-blue);
          box-shadow: 0 8px 18px rgba(20, 32, 54, 0.14);
          font: inherit;
          font-weight: 700;
          line-height: 1.1;
          padding: 0.12rem 0.22rem;
          text-align: center;
          outline: none;
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
          background: rgba(216, 152, 16, 0.08);
          border-bottom-color: var(--brand-gold);
        }
        .drop-indicator {
          position: absolute;
          top: -1.5em;
          width: 2px;
          height: 2.8em;
          background-color: var(--brand-gold);
          pointer-events: none;
          z-index: 5;
        }
        .clear-chords-button {
          position: absolute;
          right: 0.25rem;
          top: -0.4rem; /* sit in the chords area */
          background: #fff;
          border: 1px solid var(--border-soft);
          padding: 0.15rem 0.5rem;
          font-size: 0.75rem;
          color: var(--brand-blue);
          border-radius: 6px;
          cursor: pointer;
          z-index: 20;
        }
        .clear-chords-button:hover {
          background: rgba(216, 152, 16, 0.13);
          color: var(--brand-blue);
        }
        @media (hover: none), (pointer: coarse) {
          .line-editor {
            margin-top: 2.8em;
            min-height: 2em;
          }
          .chords-layer {
            top: -2.25em;
            height: 2.25em;
          }
          .chord-pill {
            min-width: 2.5rem;
            min-height: 2rem;
            padding: 0.38rem 0.45rem;
            border-radius: 6px;
            background: rgba(255, 255, 255, 0.92);
            border-color: rgba(30, 45, 72, 0.12);
            box-shadow: 0 4px 12px rgba(20, 32, 54, 0.08);
            touch-action: none;
          }
          .chord-pill.is-touch-dragging {
            cursor: grabbing;
            box-shadow: 0 8px 18px rgba(20, 32, 54, 0.16);
          }
          .chord-edit-input {
            top: 0.05rem;
            width: 4.25rem;
            min-width: 4rem;
            min-height: 1.75rem;
            padding: 0.22rem 0.3rem;
            border-radius: 6px;
          }
          .drop-indicator {
            top: -2.25em;
            height: 3.4em;
          }
          .clear-chords-button {
            top: -0.15rem;
            min-height: 2rem;
          }
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
    const leftPad = 14;
    return (
        <div className="directive-editor" style={{ marginBottom: '0.5em', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input 
                value={line} 
                onChange={e => onChange(e.target.value)} 
                spellCheck={false}
                style={{ flex: 1, paddingLeft: `${leftPad}px` }}
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
  const TOUCH_DRAG_THRESHOLD_PX = 8;
  const containerRef = useRef<HTMLDivElement>(null);
  const lyricsInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const previousLineRef = useRef(line);
  const skipNextBlurCommitRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const touchDragRef = useRef<{
    pointerId: number;
    chordIndex: number;
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [selectedChordIndex, setSelectedChordIndex] = useState<number | null>(null);
  const [touchDraggingChordIndex, setTouchDraggingChordIndex] = useState<number | null>(null);
  const [editingChord, setEditingChord] = useState<ChordEditState | null>(null);
  
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

  useEffect(() => {
    if (previousLineRef.current === line) return;
    previousLineRef.current = line;

    if (editingChord?.chordIndex === null) {
      skipNextBlurCommitRef.current = true;
    }
    setEditingChord((current) => syncChordEditWithLine(current, line));
  }, [editingChord?.chordIndex, line]);

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

  const getMeasureContext = () => {
    if (!measureCanvasRef.current) {
      measureCanvasRef.current = document.createElement('canvas');
    }

    const context = measureCanvasRef.current.getContext('2d');
    const input = lyricsInputRef.current;
    if (!context || !input) return null;

    const style = window.getComputedStyle(input);
    context.font = style.font;
    context.letterSpacing = style.letterSpacing === 'normal' ? '0px' : style.letterSpacing;
    return context;
  };

  const getCharPositions = (text = lyrics) => {
    const context = getMeasureContext();
    if (!context) {
      return Array.from({ length: text.length + 1 }, (_, index) => index * 9.6);
    }

    return Array.from({ length: text.length + 1 }, (_, index) =>
      context.measureText(text.slice(0, index)).width
    );
  };

  const getCharX = (index: number) => {
    const charPositions = getCharPositions();
    const clampedIndex = Math.max(0, Math.min(index, charPositions.length - 1));
    return charPositions[clampedIndex] ?? 0;
  };

  const getCharIndexFromClientX = (clientX: number) => {
    if (!containerRef.current) return 0;

    const rect = containerRef.current.getBoundingClientRect();
    const offsetX = clientX - rect.left - leftPad;
    const charPositions = getCharPositions();

    for (let i = 0; i < charPositions.length - 1; i++) {
      const midpoint = (charPositions[i] + charPositions[i + 1]) / 2;
      if (offsetX < midpoint) return i;
    }

    return lyrics.length;
  };

  const moveChord = (chordIndex: number, newIndex: number) => {
    const chordToMove = chords[chordIndex];
    if (!chordToMove) return;

    const newChords = [...chords];
    newChords[chordIndex] = {
      ...chordToMove,
      index: Math.max(0, Math.min(newIndex, lyrics.length))
    };
    reconstructLine(lyrics, newChords);
  };

  const deleteChord = (chordIndex: number) => {
    const newChords = [...chords];
    newChords.splice(chordIndex, 1);
    setSelectedChordIndex(null);
    setEditingChord(null);
    reconstructLine(lyrics, newChords);
  };

  const startEditingChord = (chordIndex: number) => {
    const chord = chords[chordIndex];
    if (!chord) return;
    skipNextBlurCommitRef.current = false;
    setSelectedChordIndex(chordIndex);
    setEditingChord({ chordIndex, charIndex: chord.index, value: chord.name });
  };

  const startAddingChord = (charIndex: number) => {
    skipNextBlurCommitRef.current = false;
    setSelectedChordIndex(null);
    setEditingChord({ chordIndex: null, charIndex, value: '' });
  };

  const commitChordEdit = () => {
    if (!editingChord) return;
    skipNextBlurCommitRef.current = true;

    const newName = editingChord.value.trim();
    if (editingChord.chordIndex === null) {
      if (newName) {
        reconstructLine(lyrics, [
          ...chords,
          { name: newName, index: editingChord.charIndex, originalTokenIndex: -1 }
        ]);
      }
      setEditingChord(null);
      return;
    }

    if (!newName) {
      deleteChord(editingChord.chordIndex);
      return;
    }

    const chord = chords[editingChord.chordIndex];
    if (!chord) {
      setEditingChord(null);
      return;
    }

    const newChords = [...chords];
    newChords[editingChord.chordIndex] = { ...chord, name: newName };
    setEditingChord(null);
    reconstructLine(lyrics, newChords);
  };

  const cancelChordEdit = () => {
    skipNextBlurCommitRef.current = true;
    setEditingChord(null);
  };

  useEffect(() => {
    if (!editingChord || !editInputRef.current) return;
    editInputRef.current.focus();
    editInputRef.current.select();
  }, [editingChord?.chordIndex, editingChord?.charIndex]);

  const handleDragStart = (e: React.DragEvent, chordIndex: number) => {
    e.dataTransfer.setData('chordIndex', chordIndex.toString());
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    setDropIndex(getCharIndexFromClientX(e.clientX));
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
    
    if (!containerRef.current || !chordToMove) return;

    moveChord(chordArrIndex, getCharIndexFromClientX(e.clientX));
  };

  const handleChordClick = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    startEditingChord(index);
  };

  const handleChordPointerDown = (e: React.PointerEvent<HTMLButtonElement>, chordIndex: number) => {
    if (e.pointerType === 'mouse') return;
    const chord = chords[chordIndex];
    if (!chord) return;

    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedChordIndex(chordIndex);
    touchDragRef.current = {
      pointerId: e.pointerId,
      chordIndex,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
    };
    suppressNextClickRef.current = true;
  };

  const handleChordPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const touchDrag = touchDragRef.current;
    if (!touchDrag || touchDrag.pointerId !== e.pointerId) return;

    e.stopPropagation();
    const deltaX = e.clientX - touchDrag.startX;
    const deltaY = e.clientY - touchDrag.startY;
    const distance = Math.hypot(deltaX, deltaY);

    if (!touchDrag.isDragging && distance >= TOUCH_DRAG_THRESHOLD_PX) {
      touchDrag.isDragging = true;
      suppressNextClickRef.current = true;
      setEditingChord(null);
      setTouchDraggingChordIndex(touchDrag.chordIndex);
    }

    if (touchDrag.isDragging) {
      e.preventDefault();
      setDropIndex(getCharIndexFromClientX(e.clientX));
    }
  };

  const handleChordPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const touchDrag = touchDragRef.current;
    if (!touchDrag || touchDrag.pointerId !== e.pointerId) return;

    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (touchDrag.isDragging) {
      e.preventDefault();
      moveChord(touchDrag.chordIndex, getCharIndexFromClientX(e.clientX));
      setDropIndex(null);
      setTouchDraggingChordIndex(null);
      suppressNextClickRef.current = true;
    } else {
      setSelectedChordIndex(touchDrag.chordIndex);
      suppressNextClickRef.current = true;
      startEditingChord(touchDrag.chordIndex);
    }

    touchDragRef.current = null;
  };

  const handleChordPointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    const touchDrag = touchDragRef.current;
    if (!touchDrag || touchDrag.pointerId !== e.pointerId) return;

    setDropIndex(null);
    setTouchDraggingChordIndex(null);
    suppressNextClickRef.current = true;
    touchDragRef.current = null;
  };

  const handleLayerClick = (e: React.MouseEvent) => {
    if (!containerRef.current || e.target !== e.currentTarget) return;
    startAddingChord(getCharIndexFromClientX(e.clientX));
  };

  const handleChordKeyDown = (e: React.KeyboardEvent, chordIndex: number) => {
    const chord = chords[chordIndex];
    if (!chord) return;

    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      startEditingChord(chordIndex);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteChord(chordIndex);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const delta = e.key === 'ArrowLeft' ? -1 : 1;
      moveChord(chordIndex, chord.index + delta * (e.shiftKey ? 4 : 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveChord(chordIndex, 0);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveChord(chordIndex, lyrics.length);
    } else if (e.key === 'Escape') {
      setSelectedChordIndex(null);
    }
  };

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitChordEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelChordEdit();
    } else if (
      (e.key === 'Delete' || e.key === 'Backspace') &&
      editingChord?.chordIndex !== null &&
      editingChord?.value === ''
    ) {
      e.preventDefault();
      deleteChord(editingChord.chordIndex);
    }
  };

  const handleEditBlur = () => {
    if (skipNextBlurCommitRef.current) {
      skipNextBlurCommitRef.current = false;
      return;
    }
    commitChordEdit();
  };

  // Increased left pad to ensure first chord (which is centered at index 0) doesn't clip
  const leftPad = 14;

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
            style={{ left: `${getCharX(dropIndex) + leftPad}px` }}
        />
      )}
      <div 
        className="chords-layer"
        onClick={handleLayerClick}
        style={{ left: `${leftPad}px` }}
      >
        {chords.map((chord, i) => (
          <button
            key={i}
            className={`chord-pill${selectedChordIndex === i ? ' is-selected' : ''}${touchDraggingChordIndex === i ? ' is-touch-dragging' : ''}`}
            style={{ left: `${getCharX(chord.index)}px` }}
            draggable
            type="button"
            onDragStart={(e) => handleDragStart(e, i)}
            onClick={(e) => handleChordClick(e, i)}
            onPointerDown={(e) => handleChordPointerDown(e, i)}
            onPointerMove={handleChordPointerMove}
            onPointerUp={handleChordPointerUp}
            onPointerCancel={handleChordPointerCancel}
            onFocus={() => setSelectedChordIndex(i)}
            onKeyDown={(e) => handleChordKeyDown(e, i)}
            title="Tap or click to edit, drag to move, arrow keys to nudge"
          >
            {chord.name}
          </button>
        ))}
        {editingChord && (
          <input
            ref={editInputRef}
            className="chord-edit-input"
            value={editingChord.value}
            onChange={(e) => setEditingChord({ ...editingChord, value: e.target.value })}
            onClick={(e) => e.stopPropagation()}
            onBlur={handleEditBlur}
            onKeyDown={handleEditKeyDown}
            spellCheck={false}
            style={{ left: `${getCharX(editingChord.charIndex)}px` }}
            aria-label={editingChord.chordIndex === null ? 'Add chord' : 'Edit chord'}
          />
        )}
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
        ref={lyricsInputRef}
        className="lyrics-input"
        value={lyrics}
        onChange={handleLyricsChange}
        spellCheck={false}
        style={{ paddingLeft: `${leftPad}px` }}
      />
    </div>
  );
}
