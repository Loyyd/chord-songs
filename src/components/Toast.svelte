<script lang="ts">
  export let kind: 'success' | 'warning' | 'error' = 'success';
  export let message = '';
  export let visible = false;
</script>

<div
  class:visible
  class="save-toast {kind}"
  role="status"
  aria-live="polite"
  aria-label={message}
>
  <div class="save-toast-icon">{kind === 'success' ? '✓' : kind === 'error' ? '×' : '!'}</div>
  <div class="save-toast-label">{message}</div>
</div>
