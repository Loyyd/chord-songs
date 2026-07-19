const NOTE_SEQUENCE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NOTE_SEQUENCE = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const CHROMATIC_KEYS = [
  'C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'
] as const;
const FLAT_MAP: Record<string, string> = {
  Db: 'C#',
  Eb: 'D#',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#'
};

function normalizeRoot(root: string): string {
  const normalizedCase = `${root.charAt(0).toUpperCase()}${root.slice(1)}`;
  return FLAT_MAP[normalizedCase] ?? normalizedCase;
}

function keyRoot(key: string): string | undefined {
  return key.match(/^([A-G](?:#|b)?)/i)?.[1];
}

function transposeRoot(root: string, steps: number, preferFlats = false): string {
  const normalized = normalizeRoot(root);
  const index = NOTE_SEQUENCE.indexOf(normalized);
  if (index === -1) return root;
  const shifted = (index + steps + NOTE_SEQUENCE.length) % NOTE_SEQUENCE.length;
  return (preferFlats ? FLAT_NOTE_SEQUENCE : NOTE_SEQUENCE)[shifted];
}

export function transposeChord(chord: string, steps: number, preferFlats = false, respell = false): string {
  if (steps === 0 && !respell) return chord;
  const match = chord.match(/^([A-G](?:#|b)?)(.*)$/i);
  if (!match) return chord;
  const [, root, suffix] = match;
  const transposedRoot = transposeRoot(root, steps, preferFlats);
  const transposedSuffix = suffix.replace(/\/([A-G](?:#|b)?)$/gi, (_match, bassRoot: string) => {
    return `/${transposeRoot(bassRoot, steps, preferFlats)}`;
  });
  return `${transposedRoot}${transposedSuffix}`;
}

export function transposeTokens(tokens: { chord: string | null; lyric: string }[], steps: number) {
  return tokens.map((token) =>
    token.chord ? { ...token, chord: transposeChord(token.chord, steps) } : token
  );
}

export function transposeDelta(fromKey: string | undefined, toKey: string | undefined): number {
  if (!fromKey || !toKey) return 0;
  const fromRoot = keyRoot(fromKey);
  const toRoot = keyRoot(toKey);
  if (!fromRoot || !toRoot) return 0;
  const from = NOTE_SEQUENCE.indexOf(normalizeRoot(fromRoot));
  const to = NOTE_SEQUENCE.indexOf(normalizeRoot(toRoot));
  if (from === -1 || to === -1) return 0;
  const delta = to - from;
  if (delta > 6) return delta - NOTE_SEQUENCE.length;
  if (delta < -6) return delta + NOTE_SEQUENCE.length;
  return delta;
}

export function transposeChordProSource(source: string, steps: number, targetKey?: string): string {
  if (steps === 0 && !targetKey) return source;

  const preferFlats = targetKey?.includes('b') ?? false;
  const lines = source.split(/\r?\n/);
  const transposedLines = lines.map(line => {
    // Handle {key: X} directive
    const keyMatch = line.match(/^(\{\s*key:\s*)([A-G](?:#|b)?[^\s}]*)(\s*\})$/i);
    if (keyMatch) {
      const [, prefix, key, suffix] = keyMatch;
      const transposedKey = targetKey ?? transposeChord(key, steps, preferFlats);
      return `${prefix}${transposedKey}${suffix}`;
    }
    
    // Transpose chords in [brackets]
    return line.replace(/\[([A-G](?:#|b)?[^\]]*)\]/g, (match, chord) => {
      return `[${transposeChord(chord, steps, preferFlats, targetKey !== undefined)}]`;
    });
  });
  
  return transposedLines.join('\n');
}
