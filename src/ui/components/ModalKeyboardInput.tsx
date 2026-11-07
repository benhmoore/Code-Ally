import { useInput } from 'ink';
import { useForceQuit } from '../hooks/useForceQuit.js';

export interface ModalSelection {
  count: number;
  selectedIndex: number;
  navigate: (index: number) => void;
  activate: (index: number) => void;
  cancel: () => void;
  createNew?: () => void;
}

/** One keyboard owner for selectors; wizard/feedback components own text editing. */
export function ModalKeyboardInput({ selection, onToggleAutoAllow }: {
  selection?: ModalSelection;
  onToggleAutoAllow?: () => void;
}) {
  useForceQuit();
  useInput((input, key) => {
    if (key.eventType === 'release' || !selection) return;
    if (key.escape || (key.ctrl && input === 'c')) { selection.cancel(); return; }
    if (key.shift && key.tab && onToggleAutoAllow) { onToggleAutoAllow(); return; }
    if (selection.createNew && !key.ctrl && !key.meta && input.toLowerCase() === 'n') {
      selection.createNew(); return;
    }
    if (selection.count === 0) return;
    const index = Math.max(0, Math.min(selection.count - 1, selection.selectedIndex));
    if (key.upArrow) selection.navigate(Math.max(0, index - 1));
    else if (key.downArrow) selection.navigate(Math.min(selection.count - 1, index + 1));
    else if (key.return) selection.activate(index);
  });
  return null;
}
