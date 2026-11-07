/** Own rewind patch reads and prevent abandoned previews from reopening a modal. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PatchManager, PatchMetadata } from '@services/PatchManager.js';
import type { RewindRequest, RewindOptionsRequest } from './useModalState.js';

type PreviewReader = Pick<PatchManager, 'getPatchesSinceTimestamp' | 'previewUndoSinceTimestamp'>;

export function useRewindPreview(
  request: RewindRequest | undefined,
  reader: PreviewReader | undefined,
  publish: (options: RewindOptionsRequest) => void,
  reportError: (message: string) => void,
) {
  const [patches, setPatches] = useState<PatchMetadata[]>([]);
  const latest = useRef({ request, reader, publish, reportError });
  latest.current = { request, reader, publish, reportError };
  const mounted = useRef(true);
  const selection = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const requestId = request?.requestId;
  const targets = request?.targets;
  useEffect(() => {
    let cancelled = false;
    selection.current++;
    setPatches([]);
    if (requestId && reader) {
      void reader.getPatchesSinceTimestamp(0).then(value => {
        if (!cancelled && mounted.current) setPatches(value);
      }, error => {
        if (!cancelled && mounted.current) latest.current.reportError(`Unable to load rewind patches: ${String(error)}`);
      });
    }
    return () => { cancelled = true; };
  }, [requestId, targets, reader]);

  const select = useCallback((selectedIndex: number) => {
    const { request: selectedRequest, reader: selectedReader } = latest.current;
    const targetMessage = selectedRequest?.targets?.[selectedIndex];
    if (!selectedRequest || !targetMessage) return;
    const generation = ++selection.current;
    const current = () => mounted.current && selection.current === generation
      && latest.current.request?.requestId === selectedRequest.requestId
      && latest.current.request?.targets === selectedRequest.targets;
    void (async () => {
      try {
        const timestamp = targetMessage.timestamp;
        const changes = selectedReader && timestamp !== undefined
          ? await selectedReader.getPatchesSinceTimestamp(timestamp) : [];
        if (!current()) return;
        const previewData = selectedReader && timestamp !== undefined
          ? await selectedReader.previewUndoSinceTimestamp(timestamp) : undefined;
        if (!current()) return;
        const paths = [...new Set(changes.map(patch => patch.file_path))];
        latest.current.publish({ selectedIndex, targetMessage,
          fileChanges: { fileCount: paths.length, files: paths.map(path => ({ path })) },
          previewData: previewData ?? undefined,
        });
      } catch (error) {
        if (current()) latest.current.reportError(`Unable to preview rewind: ${String(error)}`);
      }
    })();
  }, []);
  return { patches, select };
}
