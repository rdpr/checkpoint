import { z } from 'zod';
import { parseDiagramAnchor } from '@plannotator/core/diagram-anchor';

export const id = z.string().uuid();
export const body = z
  .string()
  .max(1_000_000, 'Artifacts must be smaller than one million characters.');
export const path = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !/[\x00-\x1f\x7f]/.test(value) &&
      value.split('/').every((part) => part && part !== '.' && part !== '..') &&
      /\.md$/i.test(value),
    'Use a relative Markdown path, such as specs/webhook-delivery.md.',
  );
export const account = z.object({
  name: z.string().trim().min(1).max(80),
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((s) => s.toLowerCase()),
  password: z.string().min(12).max(256),
});
export const credentials = account.pick({ email: true, password: true });
export const createArtifact = z.object({ workspaceId: id, path, body });
export const updateArtifact = z.object({
  artifactId: id,
  expectedRevisionId: id,
  body,
});
export const restoreArtifact = z.object({
  artifactId: id,
  revisionId: id,
  expectedRevisionId: id,
});
export const commentText = z.string().trim().min(1).max(10_000);
const textMeta = z.object({
  parentTagName: z.string().max(80),
  parentIndex: z.number().int().nonnegative().max(1000000),
  textOffset: z.number().int().nonnegative().max(1000000),
});
export const anchor = z.object({
  blockId: z.string().max(200).optional(),
  startOffset: z.number().int().nonnegative().max(1000000).optional(),
  endOffset: z.number().int().nonnegative().max(1000000).optional(),
  startMeta: textMeta.optional(),
  endMeta: textMeta.optional(),
  mathTargets: z
    .array(
      z.object({
        blockId: z.string().max(200),
        tex: z.string().max(8192),
        displayMode: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
  diagramAnchor: z
    .unknown()
    .transform((value, ctx) => {
      const parsed = parseDiagramAnchor(value);
      if (!parsed) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Invalid diagram anchor.',
        });
        return z.NEVER;
      }
      return parsed;
    })
    .optional(),
});
export const diffAnchor = z.object({
  baseRevisionId: id,
  blockIndex: z.number().int().nonnegative().max(1000000),
  side: z.enum(['added', 'removed', 'modified']),
});
export const addComment = z.object({
  submissionId: id.optional(),
  artifactId: id,
  revisionId: id,
  diff: diffAnchor.nullable().default(null),
  body: z.string().trim().max(10_000).default(''),
  kind: z.enum(['comment', 'deletion', 'label']).default('comment'),
  labelTip: z.string().max(2000).nullable().default(null),
  images: z
    .array(
      z.object({
        path: z.string().regex(/^\/api\/images\/[0-9a-f-]{36}$/),
        name: z.string().trim().min(1).max(160),
      }),
    )
    .max(8)
    .default([]),
  quote: z.string().max(8192).default(''),
  anchor: anchor.nullable().optional(),
});
export const reply = z.object({ commentId: id, body: commentText });
export const resolve = z.object({ commentId: id, resolved: z.boolean() });
export const role = z.enum(['editor', 'viewer']);

export const review = z.object({
  artifactId: id,
  expectedRevisionId: id,
  decision: z.enum(['approved', 'changes_requested', 'withdrawn']),
  note: z.string().trim().max(10000).default(''),
});
export const editComment = z.object({
  commentId: id,
  expectedVersion: z.number().int().positive(),
  body: z.string().trim().max(10000),
});
export const deleteComment = editComment.omit({ body: true });

export const reattachComment = z.object({
  commentId: id,
  expectedVersion: z.number().int().positive(),
  expectedRevisionId: id,
  quote: z.string().trim().min(1).max(8192),
  anchor,
});

export const requestReview = z.object({
  artifactId: id,
  expectedRevisionId: id,
  reviewerId: id,
  message: z.string().trim().max(5000).default(''),
});
export const cancelReviewRequest = z.object({
  requestId: id,
  expectedVersion: z.number().int().positive(),
});
export const renewReviewRequest = cancelReviewRequest.extend({
  expectedRevisionId: id,
  message: z.string().trim().max(5000).optional(),
});

export const changeArtifact = z
  .object({
    artifactId: id,
    expectedRevisionId: id,
    expectedMetadataVersion: z.number().int().positive(),
    path: path.optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (d) => d.path !== undefined || d.archived !== undefined,
    'Choose a path or archive change.',
  );
export const searchArtifacts = z.object({
  query: z.string().trim().min(1).max(200),
  workspaceId: id.optional(),
  includeArchived: z.boolean().default(false),
});

export const folderName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (name) => !/[\\/\x00-\x1f\x7f]/.test(name) && name !== '.' && name !== '..',
    'Use a folder name without slashes.',
  );
export const createFolder = z.object({
  workspaceId: id,
  parentId: id.nullable().default(null),
  name: folderName,
});
export const changeFolder = z.object({
  workspaceId: id,
  folderId: id,
  expectedCatalogVersion: z.number().int().nonnegative(),
  name: folderName.optional(),
  parentId: id.nullable().optional(),
  remove: z.boolean().default(false),
  expectedArtifacts: z
    .array(
      z.object({
        id,
        expectedRevisionId: id,
        expectedMetadataVersion: z.number().int().positive(),
      }),
    )
    .default([]),
});
