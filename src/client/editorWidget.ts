import { parseTokens } from '../lib/parseChordPro';
import { button } from './dom';

type ChangeHandler = (source: string) => void;
type PositionedChord = { name: string; index: number };

export interface SongEditorController {
  getSource(): string;
  setSource(source: string): void;
}

function splitLine(line: string) {
  const tokens = parseTokens(line);
  let lyrics = '';
  const chords: PositionedChord[] = [];
  for (const token of tokens) {
    if (token.chord) chords.push({ name: token.chord, index: lyrics.length });
    lyrics += token.lyric;
  }
  return { lyrics, chords };
}

function joinLine(lyrics: string, chords: PositionedChord[]) {
  const grouped = new Map<number, string[]>();
  for (const chord of [...chords].sort((a, b) => a.index - b.index)) {
    const index = Math.max(0, Math.min(chord.index, lyrics.length));
    grouped.set(index, [...(grouped.get(index) ?? []), chord.name]);
  }
  let value = '';
  for (let index = 0; index <= lyrics.length; index += 1) {
    for (const chord of grouped.get(index) ?? []) value += '[' + chord + ']';
    if (index < lyrics.length) value += lyrics[index];
  }
  return value;
}

function characterPositions(input: HTMLInputElement, text: string) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return Array.from({ length: text.length + 1 }, (_, index) => index * 9.6);
  const style = getComputedStyle(input);
  context.font = style.font;
  return Array.from({ length: text.length + 1 }, (_, index) => context.measureText(text.slice(0, index)).width);
}

function closestCharacter(input: HTMLInputElement, lyrics: string, clientX: number) {
  const positions = characterPositions(input, lyrics);
  const offset = clientX - input.getBoundingClientRect().left;
  for (let index = 0; index < positions.length - 1; index += 1) {
    if (offset < (positions[index] + positions[index + 1]) / 2) return index;
  }
  return lyrics.length;
}

export function mountSongEditor(root: HTMLElement, initialSource: string, onChange: ChangeHandler): SongEditorController {
  let source = initialSource;
  let copied: Array<{ line: number; chords: PositionedChord[] }> | null = null;
  let copiedName = '';

  const shell = document.createElement('div');
  shell.className = 'song-editor';
  const split = document.createElement('div');
  split.className = 'editor-split';

  const rawPane = document.createElement('section');
  rawPane.className = 'editor-pane raw-pane';
  rawPane.setAttribute('aria-label', 'Raw ChordPro source');
  const rawTitle = document.createElement('div');
  rawTitle.className = 'editor-pane-heading';
  rawTitle.textContent = 'Raw text';
  const raw = document.createElement('textarea');
  raw.className = 'raw-editor';
  raw.spellcheck = false;
  raw.value = source;
  rawPane.append(rawTitle, raw);

  const visualPane = document.createElement('section');
  visualPane.className = 'editor-pane visual-pane';
  visualPane.setAttribute('aria-label', 'Visual song editor');
  const visualTitle = document.createElement('div');
  visualTitle.className = 'editor-pane-heading';
  visualTitle.textContent = 'Visual editor';
  const visual = document.createElement('div');
  visual.className = 'editor-content song';
  visualPane.append(visualTitle, visual);
  split.append(rawPane, visualPane);
  shell.append(split);
  root.replaceChildren(shell);

  const notify = () => {
    raw.value = source;
    onChange(source);
  };
  const changeLine = (lineIndex: number, value: string, rerender = false) => {
    const lines = source.split(/\r?\n/);
    lines[lineIndex] = value;
    source = lines.join('\n');
    notify();
    if (rerender) renderVisual();
  };
  const sectionRange = (lineIndex: number) => {
    const lines = source.split(/\r?\n/);
    let start = -1;
    let name = '';
    for (let index = 0; index <= lineIndex; index += 1) {
      const match = lines[index].trim().match(/^\{\s*section:\s*(.+)\s*\}$/i);
      if (match) {
        start = index;
        name = match[1].trim();
      }
    }
    if (start < 0) return null;
    let end = lines.length - 1;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^\{\s*section:/i.test(lines[index].trim())) {
        end = index - 1;
        break;
      }
    }
    return { start, end, name };
  };

  const copySection = (lineIndex: number) => {
    const section = sectionRange(lineIndex);
    if (!section) return;
    const lines = source.split(/\r?\n/);
    copied = [];
    let relative = 0;
    for (let index = section.start + 1; index <= section.end; index += 1) {
      const trimmed = lines[index].trim();
      if (!trimmed || (trimmed.startsWith('{') && trimmed.endsWith('}'))) continue;
      const parsed = splitLine(lines[index]);
      if (parsed.chords.length) copied.push({ line: relative, chords: parsed.chords });
      relative += 1;
    }
    copiedName = section.name;
    renderVisual();
  };

  const pasteSection = (lineIndex: number) => {
    const section = sectionRange(lineIndex);
    if (!section || !copied) return;
    const lines = source.split(/\r?\n/);
    let relative = 0;
    for (let index = section.start + 1; index <= section.end; index += 1) {
      const trimmed = lines[index].trim();
      if (!trimmed || (trimmed.startsWith('{') && trimmed.endsWith('}'))) continue;
      const match = copied.find((item) => item.line === relative);
      if (match) {
        const lyrics = splitLine(lines[index]).lyrics;
        lines[index] = joinLine(lyrics, match.chords);
      }
      relative += 1;
    }
    source = lines.join('\n');
    notify();
    renderVisual();
  };

  const renderLine = (line: string, lineIndex: number) => {
    const parsed = splitLine(line);
    const row = document.createElement('div');
    row.className = 'line-editor';
    const chordLayer = document.createElement('div');
    chordLayer.className = 'chords-layer';
    const lyrics = document.createElement('input');
    lyrics.className = 'lyrics-input';
    lyrics.spellcheck = false;
    lyrics.value = parsed.lyrics;
    lyrics.style.paddingLeft = '14px';

    const position = (index: number) => (characterPositions(lyrics, parsed.lyrics)[index] ?? 0) + 'px';
    const updateChord = (chordIndex: number, next: PositionedChord | null) => {
      const chords = [...parsed.chords];
      if (next) chords[chordIndex] = next; else chords.splice(chordIndex, 1);
      changeLine(lineIndex, joinLine(parsed.lyrics, chords), true);
    };
    const editChord = (chordIndex: number) => {
      const chord = parsed.chords[chordIndex];
      if (!chord) return;
      const editor = document.createElement('input');
      editor.className = 'chord-edit-input';
      editor.value = chord.name;
      editor.style.left = position(chord.index);
      editor.setAttribute('aria-label', 'Edit chord');
      const commit = () => updateChord(chordIndex, editor.value.trim() ? { ...chord, name: editor.value.trim() } : null);
      editor.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); commit(); }
        if (event.key === 'Escape') { event.preventDefault(); renderVisual(); }
      });
      editor.addEventListener('blur', commit, { once: true });
      chordLayer.append(editor);
      queueMicrotask(() => { editor.focus(); editor.select(); });
    };

    parsed.chords.forEach((chord, chordIndex) => {
      const pill = button(chord.name, 'chord-pill');
      pill.draggable = true;
      pill.style.left = position(chord.index);
      pill.title = 'Tap or click to edit, drag to move, arrow keys to nudge';
      pill.addEventListener('click', (event) => { event.stopPropagation(); editChord(chordIndex); });
      pill.addEventListener('dragstart', (event) => event.dataTransfer?.setData('text/chord-index', String(chordIndex)));
      pill.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === 'F2') editChord(chordIndex);
        else if (event.key === 'Delete' || event.key === 'Backspace') updateChord(chordIndex, null);
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const delta = event.key === 'ArrowLeft' ? -1 : 1;
          updateChord(chordIndex, { ...chord, index: chord.index + delta * (event.shiftKey ? 4 : 1) });
        }
      });
      let touch: { pointerId: number; startX: number; startY: number; dragging: boolean } | null = null;
      pill.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse') return;
        pill.setPointerCapture(event.pointerId);
        touch = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dragging: false };
      });
      pill.addEventListener('pointermove', (event) => {
        if (!touch || touch.pointerId !== event.pointerId) return;
        if (Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY) > 8) {
          touch.dragging = true;
          pill.classList.add('is-touch-dragging');
          event.preventDefault();
        }
      });
      pill.addEventListener('pointerup', (event) => {
        if (!touch || touch.pointerId !== event.pointerId) return;
        if (touch.dragging) updateChord(chordIndex, { ...chord, index: closestCharacter(lyrics, parsed.lyrics, event.clientX) });
        else editChord(chordIndex);
        touch = null;
      });
      chordLayer.append(pill);
    });

    chordLayer.addEventListener('click', (event) => {
      if (event.target !== chordLayer) return;
      const index = closestCharacter(lyrics, parsed.lyrics, event.clientX);
      const editor = document.createElement('input');
      editor.className = 'chord-edit-input';
      editor.style.left = position(index);
      editor.setAttribute('aria-label', 'Add chord');
      const commit = () => {
        const name = editor.value.trim();
        if (name) changeLine(lineIndex, joinLine(parsed.lyrics, [...parsed.chords, { name, index }]), true);
        else renderVisual();
      };
      editor.addEventListener('keydown', (keyEvent) => {
        if (keyEvent.key === 'Enter') commit();
        if (keyEvent.key === 'Escape') renderVisual();
      });
      editor.addEventListener('blur', commit, { once: true });
      chordLayer.append(editor);
      queueMicrotask(() => editor.focus());
    });
    row.addEventListener('dragover', (event) => event.preventDefault());
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const chordIndex = Number(event.dataTransfer?.getData('text/chord-index'));
      const chord = parsed.chords[chordIndex];
      if (chord) updateChord(chordIndex, { ...chord, index: closestCharacter(lyrics, parsed.lyrics, event.clientX) });
    });
    if (parsed.chords.length) {
      const clear = button('Clear chords', 'clear-chords-button');
      clear.addEventListener('click', () => changeLine(lineIndex, parsed.lyrics, true));
      row.append(clear);
    }
    lyrics.addEventListener('input', () => {
      source = source.split(/\r?\n/).map((value, index) => index === lineIndex ? joinLine(lyrics.value, parsed.chords) : value).join('\n');
      notify();
    });
    row.append(chordLayer, lyrics);
    return row;
  };

  function renderVisual() {
    visual.replaceChildren();
    const lines = source.split(/\r?\n/);
    lines.forEach((line, lineIndex) => {
      const trimmed = line.trim();
      if (!trimmed) {
        const spacer = document.createElement('div');
        spacer.className = 'line-spacer';
        visual.append(spacer);
        return;
      }
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        const row = document.createElement('div');
        row.className = 'directive-editor';
        const input = document.createElement('input');
        input.value = line;
        input.spellcheck = false;
        input.addEventListener('input', () => changeLine(lineIndex, input.value));
        row.append(input);
        if (/^\{\s*section:/i.test(trimmed)) {
          const actions = document.createElement('div');
          actions.className = 'section-actions';
          const copy = button('Copy', 'section-action-button');
          copy.title = 'Copy all chords from this section';
          copy.addEventListener('click', () => copySection(lineIndex));
          actions.append(copy);
          if (copied) {
            const paste = button('Paste', 'section-action-button');
            paste.title = 'Paste chords from ' + (copiedName || 'copied section');
            paste.addEventListener('click', () => pasteSection(lineIndex));
            actions.append(paste);
          }
          row.append(actions);
        }
        visual.append(row);
      } else visual.append(renderLine(line, lineIndex));
    });
  }

  raw.addEventListener('input', () => {
    source = raw.value;
    onChange(source);
    renderVisual();
  });
  renderVisual();

  return {
    getSource: () => source,
    setSource(nextSource) {
      source = nextSource;
      raw.value = source;
      onChange(source);
      renderVisual();
    },
  };
}
