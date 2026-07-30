import assert from 'node:assert/strict';
import test from 'node:test';
import type { LiveAction, NewLiveAction } from './liveState';
import { mergeActions, moveAnchorForTarget, replayActions } from './liveState';

const action = (value: NewLiveAction & { counter: number; actor?: string }): LiveAction => {
  const { counter, actor = 'peer-a', ...operation } = value;
  return {
    ...operation,
    id: `${actor}:${counter}`,
    revision: { counter, actor },
  } as LiveAction;
};

test('replays add, move, select, and delete actions', () => {
  const actions = [
    action({ type: 'add', entryId: 'one', songId: 'song-one', afterEntryId: null, counter: 1 }),
    action({ type: 'add', entryId: 'two', songId: 'song-two', afterEntryId: 'one', counter: 2 }),
    action({ type: 'add', entryId: 'three', songId: 'song-three', afterEntryId: 'two', counter: 3 }),
    action({ type: 'move', entryId: 'three', afterEntryId: null, counter: 4 }),
    action({ type: 'select', entryId: 'two', counter: 5 }),
    action({ type: 'delete', entryId: 'two', counter: 6 }),
  ];

  assert.deepEqual(replayActions(actions), {
    entries: [
      { id: 'three', songId: 'song-three' },
      { id: 'one', songId: 'song-one' },
    ],
    activeEntryId: null,
  });
});

test('resolves drag targets to one stable move anchor', () => {
  const entries = [
    { id: 'one', songId: 'song-one' },
    { id: 'two', songId: 'song-two' },
    { id: 'three', songId: 'song-three' },
  ];

  assert.equal(moveAnchorForTarget(entries, 'three', 0), null);
  assert.equal(moveAnchorForTarget(entries, 'one', 2), 'three');
  assert.equal(moveAnchorForTarget(entries, 'two', 1), undefined);
  assert.equal(moveAnchorForTarget(entries, 'missing', 0), undefined);
  assert.equal(moveAnchorForTarget(entries, 'one', 99), 'three');
});

test('ignores duplicate and impossible actions', () => {
  const actions = [
    action({ type: 'add', entryId: 'one', songId: 'song-one', afterEntryId: null, counter: 1 }),
    action({ type: 'delete', entryId: 'missing', counter: 2 }),
    action({ type: 'move', entryId: 'one', afterEntryId: 'missing', counter: 3 }),
    action({ type: 'delete', entryId: 'one', counter: 4 }),
    action({ type: 'delete', entryId: 'one', counter: 5 }),
  ];

  assert.deepEqual(replayActions(actions), { entries: [], activeEntryId: null });
});

test('merges peer logs once and gives concurrent actions a stable order', () => {
  const first = action({
    type: 'add',
    entryId: 'one',
    songId: 'song-one',
    afterEntryId: null,
    counter: 1,
    actor: 'peer-a',
  });
  const concurrent = action({
    type: 'add',
    entryId: 'two',
    songId: 'song-two',
    afterEntryId: null,
    counter: 1,
    actor: 'peer-b',
  });

  assert.deepEqual(
    mergeActions([concurrent], [first, concurrent]).map((entry) => entry.id),
    [first.id, concurrent.id],
  );
});
