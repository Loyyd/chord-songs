import type { SongData, SongLineToken, SongSection } from '../types';
import { dedupeCategories, parseCategoryList } from './songCategories';

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseTokens(line: string): SongLineToken[] {
  const tokens: SongLineToken[] = [];
  const regex = /\[([^\]]+)\]/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(line))) {
    const chord = match[1].trim();
    const lyricBefore = line.slice(lastIndex, match.index);
    
    if (lyricBefore) {
      tokens.push({ chord: null, lyric: lyricBefore });
    }
    
    lastIndex = regex.lastIndex;
    
    // Find the next chord position or end of line
    const remainingText = line.slice(lastIndex);
    const nextChordIndex = remainingText.search(/\[/);
    const lyricAfter = nextChordIndex === -1 
      ? remainingText 
      : remainingText.slice(0, nextChordIndex);
    
    tokens.push({ chord, lyric: lyricAfter });
    lastIndex += lyricAfter.length;
  }

  // Handle any remaining text (shouldn't happen with correct parsing)
  const trailing = line.slice(lastIndex);
  if (trailing && trailing.trim()) {
    tokens.push({ chord: null, lyric: trailing });
  }

  if (tokens.length === 0) {
    tokens.push({ chord: null, lyric: '' });
  }

  return tokens;
}

export function serializeTokens(tokens: SongLineToken[]): string {
  return tokens.map(t => {
    const chordPart = t.chord ? `[${t.chord}]` : '';
    return `${chordPart}${t.lyric}`;
  }).join('');
}

export function parseChordPro(raw: string, sourcePath = 'inline'): SongData {
  const lines = raw.split(/\r?\n/);
  let title = 'Untitled';
  let key: string | undefined;
  let interpret: string | undefined;
  const categories: string[] = [];
  const sections: SongSection[] = [];
  let currentSection: SongSection = { name: 'Verse', lines: [] };
  let isDefaultSection = true; // Track if we're still on the default section

  const commitSection = () => {
    // Only commit if there are lines and it's not an empty default section
    if (currentSection.lines.length > 0 && 
        !(isDefaultSection && currentSection.lines.every(l => l.raw.trim() === ''))) {
      sections.push(currentSection);
    }
  };

  for (const line of lines) {
    const metaMatch = line.match(/^\{\s*([^:]+):\s*(.+)\s*\}$/);
    if (metaMatch) {
      const [, tag, value] = metaMatch;
      const tagLower = tag.trim().toLowerCase();
      const val = value.trim();
      if (tagLower === 'title') {
        title = val;
      } else if (tagLower === 'key') {
        key = val;
      } else if (tagLower === 'interpret' || tagLower === 'interpreter' || tagLower === 'artist') {
        interpret = val;
      } else if (tagLower === 'category' || tagLower === 'categories') {
        categories.push(...parseCategoryList(val));
      } else if (tagLower === 'section') {
        commitSection();
        currentSection = { name: val, lines: [] };
        isDefaultSection = false; // Mark that we've moved away from default section
      }
      continue;
    }

    if (line.trim() === '') {
      currentSection.lines.push({ tokens: [{ chord: null, lyric: '' }], raw: '' });
      continue;
    }

    currentSection.lines.push({ tokens: parseTokens(line), raw: line });
  }

  commitSection();

  const id = slugify(title);

  return {
    id,
    title,
    key,
    interpret,
    categories: dedupeCategories(categories),
    sections,
    sourcePath,
    source: raw
  };
}
