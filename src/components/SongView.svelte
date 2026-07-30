<script lang="ts">
  import { transposeTokens } from '../lib/chords';
  import type { SongData, SongLineToken } from '../types';

  export let song: SongData;
  export let transpose = 0;
  export let query = '';

  type DisplayToken = { chord: string | null; lyric: string };

  function mergeTokens(tokens: SongLineToken[]): DisplayToken[] {
    const merged: DisplayToken[] = [];
    let pending: string | null = null;
    for (const token of tokens) {
      if (token.chord && !token.lyric) pending = token.chord;
      else if (pending) {
        merged.push({ chord: pending, lyric: token.lyric || '' });
        pending = null;
      } else merged.push({ chord: token.chord, lyric: token.lyric || '' });
    }
    if (pending) merged.push({ chord: pending, lyric: '' });
    return merged;
  }

  function highlighted(lyric: string) {
    const needle = query.trim();
    if (!needle || !lyric) return [{ text: lyric, match: false }];
    const lower = lyric.toLowerCase();
    const search = needle.toLowerCase();
    const parts: Array<{ text: string; match: boolean }> = [];
    let start = 0;
    let index = lower.indexOf(search);
    while (index >= 0) {
      if (index > start) parts.push({ text: lyric.slice(start, index), match: false });
      parts.push({ text: lyric.slice(index, index + needle.length), match: true });
      start = index + needle.length;
      index = lower.indexOf(search, start);
    }
    if (start < lyric.length) parts.push({ text: lyric.slice(start), match: false });
    return parts;
  }
</script>

<div class="song">
  {#each song.sections ?? [] as section}
    <div>
      <div class="section-title">{section.name}</div>
      {#each section.lines as line}
        {@const tokens = transposeTokens(line.tokens, transpose)}
        <div class:has-chords={tokens.some((token) => token.chord)} class="line">
          {#each mergeTokens(tokens) as token}
            {@const leading = token.chord ? token.lyric.match(/^\s+/)?.[0] ?? '' : ''}
            {@const lyric = token.chord ? token.lyric.slice(leading.length) : token.lyric}
            <span>
              {#if leading}<span class="lyric">{leading}</span>{/if}
              <span class="token">
                {#if token.chord}<span class="chord">{token.chord}</span>{/if}
                <span class="lyric">
                  {#each highlighted(lyric) as part}
                    {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
                  {/each}
                  {#if token.chord && !lyric}
                    <span class="chord-flow-spacer" aria-hidden="true">{token.chord}</span>
                  {:else if token.chord && token.chord.length > lyric.length}
                    <span class="chord-spacer">{'\u00a0'.repeat(token.chord.length - lyric.length)}</span>
                  {/if}
                </span>
              </span>
            </span>
          {/each}
        </div>
      {/each}
    </div>
  {/each}
</div>
