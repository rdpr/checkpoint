import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
const { computePlanDiff } = await import(
  '@plannotator/ui/utils/planDiffEngine'
);
const { oldText, newText, blockIndex } = workerData;
const block = computePlanDiff(oldText, newText).blocks[blockIndex];
// Preserve upstream block numbering and source text; rendering tokens stay here.
parentPort.postMessage(
  block && {
    type: block.type,
    content: block.content,
    oldContent: block.oldContent,
  },
);
