<script lang="ts">
  import { parseTokens } from '../lib/parseChordPro';
  import LineEditor from './LineEditor.svelte';

  type PositionedChord = { name: string; index: number };
  type CopiedLine = { line: number; chords: PositionedChord[] };

  export let source: string;
  export let onChange: (source: string) => void;

  let copied: CopiedLine[] | null = null;
  let copiedName = '';
  $: lines = source.split(/\r?\n/);

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
      for (const chord of grouped.get(index) ?? []) value += `[${chord}]`;
      if (index < lyrics.length) value += lyrics[index];
    }
    return value;
  }

  function changeLine(lineIndex: number, value: string) {
    const next = [...lines];
    next[lineIndex] = value;
    onChange(next.join('\n'));
  }

  function sectionRange(lineIndex: number) {
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
  }

  function copySection(lineIndex: number) {
    const section = sectionRange(lineIndex);
    if (!section) return;
    const next: CopiedLine[] = [];
    let relative = 0;
    for (let index = section.start + 1; index <= section.end; index += 1) {
      const trimmed = lines[index].trim();
      if (!trimmed || (trimmed.startsWith('{') && trimmed.endsWith('}'))) continue;
      const parsed = splitLine(lines[index]);
      if (parsed.chords.length) next.push({ line: relative, chords: parsed.chords });
      relative += 1;
    }
    copied = next;
    copiedName = section.name;
  }

  function pasteSection(lineIndex: number) {
    const section = sectionRange(lineIndex);
    if (!section || !copied) return;
    const next = [...lines];
    let relative = 0;
    for (let index = section.start + 1; index <= section.end; index += 1) {
      const trimmed = next[index].trim();
      if (!trimmed || (trimmed.startsWith('{') && trimmed.endsWith('}'))) continue;
      const match = copied.find((item) => item.line === relative);
      if (match) next[index] = joinLine(splitLine(next[index]).lyrics, match.chords);
      relative += 1;
    }
    onChange(next.join('\n'));
  }
</script>

<div class="song-editor">
  <div class="editor-split">
    <section class="editor-pane raw-pane" aria-label="Raw ChordPro source">
      <div class="editor-pane-heading">Raw text</div>
      <textarea
        class="raw-editor"
        spellcheck="false"
        value={source}
        on:input={(event) => onChange(event.currentTarget.value)}
      ></textarea>
    </section>

    <section class="editor-pane visual-pane" aria-label="Visual song editor">
      <div class="editor-pane-heading">Visual editor</div>
      <div class="editor-content song">
        {#each lines as line, lineIndex (lineIndex)}
          {@const trimmed = line.trim()}
          {#if !trimmed}
            <div class="line-spacer"></div>
          {:else if trimmed.startsWith('{') && trimmed.endsWith('}')}
            <div class="directive-editor">
              <input
                value={line}
                spellcheck="false"
                on:input={(event) => changeLine(lineIndex, event.currentTarget.value)}
              />
              {#if /^\{\s*section:/i.test(trimmed)}
                <div class="section-actions">
                  <button
                    type="button"
                    class="section-action-button"
                    title="Copy all chords from this section"
                    on:click={() => copySection(lineIndex)}
                  >Copy</button>
                  {#if copied}
                    <button
                      type="button"
                      class="section-action-button"
                      title="Paste chords from {copiedName || 'copied section'}"
                      on:click={() => pasteSection(lineIndex)}
                    >Paste</button>
                  {/if}
                </div>
              {/if}
            </div>
          {:else}
            <LineEditor {line} onChange={(value) => changeLine(lineIndex, value)} />
          {/if}
        {/each}
      </div>
    </section>
  </div>
</div>
