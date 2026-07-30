<script lang="ts">
  import { categoryColors, songSubtitle } from '../appUtils';
  import type { SongData, SongIndexEntry } from '../types';

  export let song: Pick<SongData | SongIndexEntry, 'key' | 'interpret' | 'categories'>;
  export let onRemove: ((category: string) => void) | undefined = undefined;
</script>

<div class="song-meta">
  <span class="song-subtitle">{songSubtitle(song) || 'Key: —'}</span>
  {#if song.categories?.length}
    <span class="category-chips" aria-label="Song categories">
      {#each song.categories as category}
        <span class="category-chip" style:color={categoryColors(category).color}>
          {category}
          {#if onRemove}
            <button
              type="button"
              class="category-chip-remove"
              title="Remove {category}"
              aria-label="Remove {category}"
              on:click={() => onRemove?.(category)}
            >×</button>
          {/if}
        </span>
      {/each}
    </span>
  {/if}
</div>
