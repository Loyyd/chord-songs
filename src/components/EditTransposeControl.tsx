import { CHROMATIC_KEYS, transposeDelta } from '../lib/chords';

interface EditTransposeControlProps {
  currentKey?: string;
  disabled?: boolean;
  onTranspose: (steps: number, targetKey?: string) => void;
}

export function EditTransposeControl({ currentKey, disabled, onTranspose }: EditTransposeControlProps) {
  const keySuffix = currentKey?.match(/^[A-G](?:#|b)?(.*)$/i)?.[1] ?? '';
  const availableKeys = CHROMATIC_KEYS.map((key) => `${key}${keySuffix}`);
  const selectedKey = availableKeys.find((key) => key === currentKey) ?? '';

  const handleTargetKey = (targetKey: string) => {
    if (!currentKey || !targetKey) return;
    onTranspose(transposeDelta(currentKey, targetKey), targetKey);
  };

  return (
    <div className="edit-transpose-control" aria-label="Transpose the whole song">
      <span className="edit-transpose-title">Transpose song</span>
      <div className="edit-transpose-steps">
        <button
          type="button"
          onClick={() => onTranspose(-1)}
          disabled={disabled}
          aria-label="Transpose whole song down one semitone"
          title="Transpose whole song down one semitone"
        >
          −
        </button>
        <span className="edit-transpose-current" aria-label={`Current key ${currentKey ?? 'not set'}`}>
          {currentKey ?? 'No key'}
        </span>
        <button
          type="button"
          onClick={() => onTranspose(1)}
          disabled={disabled}
          aria-label="Transpose whole song up one semitone"
          title="Transpose whole song up one semitone"
        >
          +
        </button>
      </div>
      <label className="edit-transpose-key">
        <span>Target key</span>
        <select
          value={selectedKey}
          onChange={(event) => handleTargetKey(event.target.value)}
          disabled={disabled || !currentKey}
          title={currentKey ? 'Transpose the whole song to this key' : 'Add a {key: ...} directive to choose a target key'}
        >
          {!selectedKey && <option value="">Choose key</option>}
          {availableKeys.map((key) => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
      </label>
      <span className="edit-transpose-hint">Updates the source and every chord immediately.</span>
    </div>
  );
}
