import { parseTokens } from './parseChordPro';

export type ChordEditState = {
  chordIndex: number | null;
  charIndex: number;
  value: string;
};

/**
 * Reconcile an open chord input after its complete source line changed elsewhere
 * (for example, when the edit page transposes the whole song).
 */
export function syncChordEditWithLine(
  editingChord: ChordEditState | null,
  nextLine: string,
): ChordEditState | null {
  if (!editingChord || editingChord.chordIndex === null) {
    // A pending new chord has no stable identity in an externally changed line.
    return null;
  }

  let lyricLength = 0;
  const chords: Array<{ name: string; charIndex: number }> = [];
  for (const token of parseTokens(nextLine)) {
    if (token.chord) {
      chords.push({ name: token.chord, charIndex: lyricLength });
    }
    lyricLength += token.lyric.length;
  }

  const chord = chords[editingChord.chordIndex];
  if (!chord) return null;

  return {
    chordIndex: editingChord.chordIndex,
    charIndex: chord.charIndex,
    value: chord.name,
  };
}
