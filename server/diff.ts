import { Worker } from 'node:worker_threads';
import type { PlanDiffBlock } from '@plannotator/ui/utils/planDiffEngine';
import { AppError } from './security.ts';

export type CommentDiffBlock = Pick<
  PlanDiffBlock,
  'type' | 'content' | 'oldContent'
>;

// No queue: a burst of comparisons must not retain arbitrary revision bodies.
let active = 0;
const limitError = () =>
  new AppError(
    422,
    'comparison_too_complex',
    'This comparison is too expensive to annotate. Leave an artifact discussion instead.',
  );

export async function commentDiffBlock(
  oldText: string,
  newText: string,
  blockIndex: number,
): Promise<CommentDiffBlock | undefined> {
  if (active >= 2)
    throw new AppError(
      429,
      'comparison_busy',
      'Other comparisons are running. Retry later or leave an artifact discussion.',
    );
  const worker = new Worker(new URL('./diffWorker.mjs', import.meta.url), {
    workerData: { oldText, newText, blockIndex },
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
    },
  });
  active++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<CommentDiffBlock | undefined>(
      (resolve, reject) => {
        timer = setTimeout(() => reject(limitError()), 1500);
        worker.once('message', resolve);
        worker.once('error', () => reject(limitError()));
        worker.once('exit', () => reject(limitError()));
      },
    );
  } finally {
    clearTimeout(timer);
    // Keep the slot until termination finishes, including on timeout/OOM.
    try {
      await worker.terminate();
    } finally {
      active--;
    }
  }
}
