/// <reference types="node" />

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  transposeChord,
  transposeChordProSource,
  transposeDelta,
  transposeTokens
} from './chords';

describe('transposeChord', () => {
  it('transposes sharp and flat roots', () => {
    assert.equal(transposeChord('F#', 1), 'G');
    assert.equal(transposeChord('Bb', 2), 'C');
    assert.equal(transposeChord('Db', -1), 'C');
  });

  it('preserves chord suffixes', () => {
    assert.equal(transposeChord('F#m7', 1), 'Gm7');
    assert.equal(transposeChord('Bbmaj7', -2), 'G#maj7');
  });

  it('transposes slash-chord bass roots', () => {
    assert.equal(transposeChord('C/E', 2), 'D/F#');
    assert.equal(transposeChord('Bb/D', 2), 'C/E');
    assert.equal(transposeChord('F#m7/C#', -2), 'Em7/B');
  });

  it('leaves non-chord text unchanged', () => {
    assert.equal(transposeChord('N.C.', 3), 'N.C.');
  });
});

describe('transposeTokens', () => {
  it('transposes chord tokens without changing lyric-only tokens', () => {
    assert.deepEqual(
      transposeTokens(
        [
          { chord: null, lyric: 'Hello ' },
          { chord: 'Bb/D', lyric: 'world' }
        ],
        2
      ),
      [
        { chord: null, lyric: 'Hello ' },
        { chord: 'C/E', lyric: 'world' }
      ]
    );
  });
});

describe('transposeDelta', () => {
  it('calculates semitone deltas from flats and sharps', () => {
    assert.equal(transposeDelta('Bb', 'C'), 2);
    assert.equal(transposeDelta('F#', 'Eb'), -3);
    assert.equal(transposeDelta(undefined, 'C'), 0);
  });

  it('calculates semitone deltas for minor keys', () => {
    assert.equal(transposeDelta('Em', 'Gm'), 3);
    assert.equal(transposeDelta('F#m', 'Bbm'), 4);
  });
});

describe('transposeChordProSource', () => {
  it('transposes key directives and inline chords', () => {
    assert.equal(
      transposeChordProSource(['{key: Bb}', '[Bb/D]Amazing [F]grace'].join('\n'), 2),
      ['{key: C}', '[C/E]Amazing [G]grace'].join('\n')
    );
  });

  it('uses the selected target key spelling and leaves lyrics untouched', () => {
    assert.equal(
      transposeChordProSource(['{key: C}', '[C/E]Amazing [F#]grace'].join('\n'), -2, 'Bb'),
      ['{key: Bb}', '[Bb/D]Amazing [E]grace'].join('\n')
    );
  });

  it('respells enharmonic chords when the selected key has the same pitch', () => {
    assert.equal(
      transposeChordProSource(['{key: A#}', '[A#/D#]Song'].join('\n'), 0, 'Bb'),
      ['{key: Bb}', '[Bb/Eb]Song'].join('\n')
    );
  });

  it('preserves minor mode while transposing key directives', () => {
    assert.equal(
      transposeChordProSource(['{key: Em}', '[Em/B]Song'].join('\n'), 2),
      ['{key: F#m}', '[F#m/C#]Song'].join('\n')
    );
    assert.equal(
      transposeChordProSource(['{key: Am}', '[Am/E]Song'].join('\n'), 1, 'Bbm'),
      ['{key: Bbm}', '[Bbm/F]Song'].join('\n')
    );
  });
});
