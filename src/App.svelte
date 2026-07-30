<script lang="ts">
  import { parseAppRoute } from './appUtils';
  import BrowsePage from './components/BrowsePage.svelte';
  import EditorPage from './components/EditorPage.svelte';

  const route = parseAppRoute();
</script>

{#if route.mode === 'edit'}
  <EditorPage id={route.id} />
{:else}
  <BrowsePage />
{/if}
