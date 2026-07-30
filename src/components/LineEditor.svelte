<script lang="ts">
  import { tick } from 'svelte';
  import { syncChordEditWithLine } from '../lib/chordEditing';
  import { parseTokens } from '../lib/parseChordPro';

  type PositionedChord = { name: string; index: number };
  type EditingChord = { chordIndex: number | null; index: number; value: string };

  export let line: string;
  export let onChange: (line: string) => void;

  let lyricsInput: HTMLInputElement;
  let editing: EditingChord | null = null;
  let editInput: HTMLInputElement;
  let touch: { chordIndex: number; pointerId: number; x: number; y: number; dragging: boolean } | null = null;
  let previousLine = line;

  $: parsed = splitLine(line);
  $: if (line !== previousLine) {
    const synced = syncChordEditWithLine(
      editing && { chordIndex: editing.chordIndex, charIndex: editing.index, value: editing.value },
      line,
    );
    editing = synced && { chordIndex: synced.chordIndex, index: synced.charIndex, value: synced.value };
    previousLine = line;
  }

  function splitLine(value: string) {
    const tokens = parseTokens(value);
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
      for (const chord of grouped.get(index) ?? []) value += `[${chord}]`;
      if (index < lyrics.length) value += lyrics[index];
    }
    return value;
  }

  function positions(text: string) {
    if (!lyricsInput) return Array.from({ length: text.length + 1 }, (_, index) => index * 9.6);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return Array.from({ length: text.length + 1 }, (_, index) => index * 9.6);
    context.font = getComputedStyle(lyricsInput).font;
    return Array.from({ length: text.length + 1 }, (_, index) => context.measureText(text.slice(0, index)).width);
  }

  function left(index: number) {
    return `${positions(parsed.lyrics)[index] ?? 0}px`;
  }

  function closestCharacter(clientX: number) {
    const measured = positions(parsed.lyrics);
    const offset = clientX - lyricsInput.getBoundingClientRect().left;
    for (let index = 0; index < measured.length - 1; index += 1) {
      if (offset < (measured[index] + measured[index + 1]) / 2) return index;
    }
    return parsed.lyrics.length;
  }

  function updateChord(chordIndex: number, next: PositionedChord | null) {
    const chords = [...parsed.chords];
    if (next) chords[chordIndex] = next;
    else chords.splice(chordIndex, 1);
    editing = null;
    onChange(joinLine(parsed.lyrics, chords));
  }

  async function editChord(chordIndex: number) {
    const chord = parsed.chords[chordIndex];
    if (!chord) return;
    editing = { chordIndex, index: chord.index, value: chord.name };
    await tick();
    editInput?.focus();
    editInput?.select();
  }

  async function addChord(event: MouseEvent) {
    if (event.target !== event.currentTarget) return;
    editing = { chordIndex: null, index: closestCharacter(event.clientX), value: '' };
    await tick();
    editInput?.focus();
  }

  async function addChordWithKeyboard(event: KeyboardEvent) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    editing = { chordIndex: null, index: lyricsInput?.selectionStart ?? parsed.lyrics.length, value: '' };
    await tick();
    editInput?.focus();
  }

  function commitEdit() {
    if (!editing) return;
    const current = editing;
    editing = null;
    const name = current.value.trim();
    if (current.chordIndex === null) {
      if (name) onChange(joinLine(parsed.lyrics, [...parsed.chords, { name, index: current.index }]));
    } else {
      updateChord(current.chordIndex, name ? { name, index: current.index } : null);
    }
  }

  function chordKey(event: KeyboardEvent, chord: PositionedChord, chordIndex: number) {
    if (event.key === 'Enter' || event.key === 'F2') editChord(chordIndex);
    else if (event.key === 'Delete' || event.key === 'Backspace') updateChord(chordIndex, null);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -1 : 1;
      updateChord(chordIndex, { ...chord, index: chord.index + delta * (event.shiftKey ? 4 : 1) });
    }
  }

  function editKey(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      editing = null;
    }
  }

  function dragStart(event: DragEvent, chordIndex: number) {
    event.dataTransfer?.setData('text/chord-index', String(chordIndex));
  }

  function drop(event: DragEvent) {
    event.preventDefault();
    const chordIndex = Number(event.dataTransfer?.getData('text/chord-index'));
    const chord = parsed.chords[chordIndex];
    if (chord) updateChord(chordIndex, { ...chord, index: closestCharacter(event.clientX) });
  }

  function pointerDown(event: PointerEvent, chordIndex: number) {
    if (event.pointerType === 'mouse') return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    touch = { chordIndex, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
  }

  function pointerMove(event: PointerEvent) {
    if (!touch || touch.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 8) {
      touch.dragging = true;
      event.preventDefault();
    }
  }

  function pointerUp(event: PointerEvent, chord: PositionedChord, chordIndex: number) {
    if (!touch || touch.pointerId !== event.pointerId) return;
    if (touch.dragging) updateChord(chordIndex, { ...chord, index: closestCharacter(event.clientX) });
    else editChord(chordIndex);
    touch = null;
  }
</script>

<div class="line-editor" role="group" aria-label="Editable lyric line" on:dragover|preventDefault on:drop={drop}>
  <div
    class="chords-layer"
    role="button"
    tabindex="0"
    aria-label="Add a chord to this lyric line"
    on:click={addChord}
    on:keydown={addChordWithKeyboard}
  >
    {#each parsed.chords as chord, chordIndex}
      <button
        type="button"
        class:is-touch-dragging={touch?.chordIndex === chordIndex && touch.dragging}
        class="chord-pill"
        style:left={left(chord.index)}
        draggable="true"
        title="Tap or click to edit, drag to move, arrow keys to nudge"
        on:click|stopPropagation={() => editChord(chordIndex)}
        on:keydown={(event) => chordKey(event, chord, chordIndex)}
        on:dragstart={(event) => dragStart(event, chordIndex)}
        on:pointerdown={(event) => pointerDown(event, chordIndex)}
        on:pointermove={pointerMove}
        on:pointerup={(event) => pointerUp(event, chord, chordIndex)}
      >{chord.name}</button>
    {/each}
    {#if editing}
      <input
        bind:this={editInput}
        bind:value={editing.value}
        class="chord-edit-input"
        style:left={left(editing.index)}
        aria-label={editing.chordIndex === null ? 'Add chord' : 'Edit chord'}
        on:keydown={editKey}
        on:blur={commitEdit}
      />
    {/if}
  </div>
  <input
    bind:this={lyricsInput}
    class="lyrics-input"
    spellcheck="false"
    value={parsed.lyrics}
    style:padding-left="14px"
    on:input={(event) => onChange(joinLine(event.currentTarget.value, parsed.chords))}
  />
  {#if parsed.chords.length}
    <button type="button" class="clear-chords-button" on:click={() => onChange(parsed.lyrics)}>Clear chords</button>
  {/if}
</div>
