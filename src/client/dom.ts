import { categoryColors, songSubtitle } from '../appUtils';
import type { SongData, SongIndexEntry } from '../types';

export function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

export function setHidden(element: HTMLElement, hidden: boolean) {
  element.hidden = hidden;
}

export function button(label: string, className = '') {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.textContent = label;
  return element;
}

export function renderMeta(
  target: HTMLElement,
  song: Pick<SongData | SongIndexEntry, 'key' | 'interpret' | 'categories'>,
  onRemove?: (category: string) => void,
) {
  target.replaceChildren();
  const meta = document.createElement('div');
  meta.className = 'song-meta';

  const subtitle = document.createElement('span');
  subtitle.className = 'song-subtitle';
  subtitle.textContent = songSubtitle(song) || 'Key: —';
  meta.append(subtitle);

  const categories = song.categories?.filter(Boolean) ?? [];
  if (categories.length > 0) {
    const chips = document.createElement('span');
    chips.className = 'category-chips';
    chips.setAttribute('aria-label', 'Song categories');
    for (const category of categories) {
      const chip = document.createElement('span');
      chip.className = 'category-chip';
      chip.style.color = categoryColors(category).color;
      chip.append(document.createTextNode(category));
      if (onRemove) {
        const remove = button('x', 'category-chip-remove');
        remove.title = `Remove ${category}`;
        remove.setAttribute('aria-label', remove.title);
        remove.addEventListener('click', () => onRemove(category));
        chip.append(remove);
      }
      chips.append(chip);
    }
    meta.append(chips);
  }
  target.append(meta);
}
