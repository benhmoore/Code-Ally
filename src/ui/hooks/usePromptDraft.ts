import { useCallback, useEffect, useRef, useState } from 'react';

export interface PromptDraft { text: string; cursor: number }
export const EMPTY_DRAFT: PromptDraft = { text: '', cursor: 0 };
const normalize = ({ text, cursor }: PromptDraft): PromptDraft => ({
  text, cursor: Math.max(0, Math.min(text.length, cursor)),
});

/** Text and cursor travel together across modal and conversation remounts. */
export function usePromptDraft(draft?: PromptDraft, onChange?: (draft: PromptDraft) => void) {
  const [local, setLocal] = useState(() => normalize(draft ?? EMPTY_DRAFT));
  const bufferRef = useRef(local.text);
  const cursorPositionRef = useRef(local.cursor);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const install = useCallback((next: PromptDraft) => {
    bufferRef.current = next.text;
    cursorPositionRef.current = next.cursor;
    setLocal(next);
  }, []);
  const publish = useCallback((next: PromptDraft) => {
    const value = normalize(next);
    install(value);
    onChangeRef.current?.(value);
  }, [install]);
  const updateBuffer = useCallback((text: string) => publish({ text, cursor: cursorPositionRef.current }), [publish]);
  const setCursorPosition = useCallback((cursor: number) => publish({ text: bufferRef.current, cursor }), [publish]);
  useEffect(() => {
    if (draft && (draft.text !== bufferRef.current || draft.cursor !== cursorPositionRef.current)) install(normalize(draft));
  }, [draft, install]);
  return { buffer: local.text, cursorPosition: local.cursor, bufferRef, cursorPositionRef, updateBuffer, setCursorPosition };
}
