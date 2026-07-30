export interface LiveRevision {
  counter: number;
  actor: string;
}

interface LiveActionBase {
  id: string;
  revision: LiveRevision;
}

export type LiveAction =
  | (LiveActionBase & {
      type: 'add';
      entryId: string;
      songId: string;
      afterEntryId: string | null;
    })
  | (LiveActionBase & {
      type: 'delete';
      entryId: string;
    })
  | (LiveActionBase & {
      type: 'move';
      entryId: string;
      afterEntryId: string | null;
    })
  | (LiveActionBase & {
      type: 'select';
      entryId: string | null;
    });

export interface LiveEntry {
  id: string;
  songId: string;
}

export interface LiveState {
  entries: LiveEntry[];
  activeEntryId: string | null;
}

export type NewLiveAction =
  | Omit<Extract<LiveAction, { type: 'add' }>, keyof LiveActionBase>
  | Omit<Extract<LiveAction, { type: 'delete' }>, keyof LiveActionBase>
  | Omit<Extract<LiveAction, { type: 'move' }>, keyof LiveActionBase>
  | Omit<Extract<LiveAction, { type: 'select' }>, keyof LiveActionBase>;

const EMPTY_STATE: LiveState = {
  entries: [],
  activeEntryId: null,
};

export function compareActions(left: LiveAction, right: LiveAction): number {
  if (left.revision.counter !== right.revision.counter) {
    return left.revision.counter - right.revision.counter;
  }
  const actorOrder = compareStrings(left.revision.actor, right.revision.actor);
  return actorOrder !== 0 ? actorOrder : compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function mergeActions(current: LiveAction[], incoming: LiveAction[]): LiveAction[] {
  const actions = new Map(current.map((action) => [action.id, action]));
  for (const action of incoming) {
    if (!actions.has(action.id) && isLiveAction(action)) {
      actions.set(action.id, action);
    }
  }
  return [...actions.values()].sort(compareActions);
}

export function replayActions(actions: LiveAction[]): LiveState {
  return [...actions].sort(compareActions).reduce<LiveState>((state, action) => {
    const entries = [...state.entries];

    if (action.type === 'add') {
      if (entries.some((entry) => entry.id === action.entryId)) return state;
      const insertionIndex = positionAfter(entries, action.afterEntryId);
      if (insertionIndex === null) return state;
      entries.splice(insertionIndex, 0, { id: action.entryId, songId: action.songId });
      return { ...state, entries };
    }

    if (action.type === 'delete') {
      const entryIndex = entries.findIndex((entry) => entry.id === action.entryId);
      if (entryIndex === -1) return state;
      entries.splice(entryIndex, 1);
      return {
        entries,
        activeEntryId: state.activeEntryId === action.entryId ? null : state.activeEntryId,
      };
    }

    if (action.type === 'move') {
      const entryIndex = entries.findIndex((entry) => entry.id === action.entryId);
      if (entryIndex === -1 || action.afterEntryId === action.entryId) return state;
      const [entry] = entries.splice(entryIndex, 1);
      const insertionIndex = positionAfter(entries, action.afterEntryId);
      if (insertionIndex === null) return state;
      entries.splice(insertionIndex, 0, entry);
      return { ...state, entries };
    }

    if (action.entryId !== null && !entries.some((entry) => entry.id === action.entryId)) {
      return state;
    }
    return { ...state, activeEntryId: action.entryId };
  }, EMPTY_STATE);
}

function positionAfter(entries: LiveEntry[], afterEntryId: string | null): number | null {
  if (afterEntryId === null) return 0;
  const anchorIndex = entries.findIndex((entry) => entry.id === afterEntryId);
  return anchorIndex === -1 ? null : anchorIndex + 1;
}

export function moveAnchorForTarget(
  entries: readonly LiveEntry[],
  entryId: string,
  targetIndex: number,
): string | null | undefined {
  const currentIndex = entries.findIndex((entry) => entry.id === entryId);
  if (currentIndex === -1) return undefined;

  const remainingEntries = entries.filter((entry) => entry.id !== entryId);
  const boundedTargetIndex = Math.max(0, Math.min(targetIndex, remainingEntries.length));
  if (currentIndex === boundedTargetIndex) return undefined;
  return remainingEntries[boundedTargetIndex - 1]?.id ?? null;
}

export function createLiveAction(
  actor: string,
  counter: number,
  action: NewLiveAction,
): LiveAction {
  return {
    ...action,
    id: `${actor}:${counter}:${crypto.randomUUID()}`,
    revision: { actor, counter },
  } as LiveAction;
}

export function isLiveAction(value: unknown): value is LiveAction {
  if (!value || typeof value !== 'object') return false;
  const action = value as Partial<LiveAction>;
  if (
    typeof action.id !== 'string' ||
    !action.revision ||
    typeof action.revision.counter !== 'number' ||
    !Number.isSafeInteger(action.revision.counter) ||
    action.revision.counter < 1 ||
    typeof action.revision.actor !== 'string'
  ) {
    return false;
  }

  if (action.type === 'add') {
    return (
      typeof action.entryId === 'string' &&
      typeof action.songId === 'string' &&
      (action.afterEntryId === null || typeof action.afterEntryId === 'string')
    );
  }
  if (action.type === 'delete') {
    return typeof action.entryId === 'string';
  }
  if (action.type === 'move') {
    return (
      typeof action.entryId === 'string' &&
      (action.afterEntryId === null || typeof action.afterEntryId === 'string')
    );
  }
  if (action.type === 'select') {
    return action.entryId === null || typeof action.entryId === 'string';
  }
  return false;
}
