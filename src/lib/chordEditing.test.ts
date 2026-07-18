/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { syncChordEditWithLine } from './chordEditing';

describe('syncChordEditWithLine', () => {
  it('refreshes an open chord edit after the line is transposed', () => {
    assert.deepEqual(
      syncChordEditWithLine(
        { chordIndex: 0, charIndex: 0, value: 'D/F#' },
        '[E/G#]Amazing grace',
      ),
      { chordIndex: 0, charIndex: 0, value: 'E/G#' },
    );
  });

  it('updates the character position from the new line', () => {
    assert.deepEqual(
      syncChordEditWithLine(
        { chordIndex: 1, charIndex: 5, value: 'G' },
        '[C]A longer [A]lyric',
      ),
      { chordIndex: 1, charIndex: 9, value: 'A' },
    );
  });

  it('cancels a pending new chord or an edit whose chord disappeared', () => {
    assert.equal(
      syncChordEditWithLine({ chordIndex: null, charIndex: 3, value: '' }, 'New lyric'),
      null,
    );
    assert.equal(
      syncChordEditWithLine({ chordIndex: 1, charIndex: 3, value: 'G' }, '[C]Lyric'),
      null,
    );
  });
});
