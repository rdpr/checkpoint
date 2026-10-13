import { legacyRoutes } from './compatibility.ts';
import { version } from '../shared/version.ts';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import type { Entra } from './entra.ts';
import { monitoring } from './metrics.ts';
import { z } from 'zod';
import { Store, type Actor } from './store.ts';
import { AppError, requireThat, secret, digest } from './security.ts';
import { handleMcp } from './mcp.ts';
import { authenticationLimiter, trustedProxyAddresses } from './authLimits.ts';

export interface AppOptions {
  origins: string[];
  entra?: Entra;
  requireSso?: boolean;
  metricsToken?: string;
  dataDir?: string;
  operationsFile?: string;
  secureCookies?: boolean;
  serveStatic?: boolean;
  allowSetup?: boolean;
  release?: string;
  maintenanceFile?: string;
  trustedProxies?: string[];
}
const sessionCookie = (req: Request) =>
  req.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('pw_session='))
    ?.slice('pw_session='.length) ?? '';

export function createApp(store: Store, options: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustedProxyAddresses(options.trustedProxies ?? []));
  const metrics = options.metricsToken
    ? monitoring(store, options.dataDir, options.operationsFile)
    : undefined;
  if (metrics) app.use(metrics.middleware);
  const browserActor = (req: Request) =>
    store.sessionActor(sessionCookie(req), options.requireSso);
  const callback = (req: Request) =>
    req.method === 'GET' &&
    req.path === '/api/auth/entra/callback' &&
    !!options.entra;
  const origins = new Set(options.origins.map((o) => new URL(o).origin));
  const hosts = new Set(options.origins.map((o) => new URL(o).host));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    // No credentials may cross an unexpected origin, including reads and MCP.
    if (
      !hosts.has(req.headers.host ?? '') &&
      !(
        req.method === 'GET' &&
        ['/livez', '/readyz', '/metrics'].includes(req.path)
      )
    )
      return res.status(403).json({
        code: 'invalid_host',
        message: 'Host is not configured for this installation.',
      });
    const origin = req.get('origin');
    if (origin && !origins.has(origin))
      return res.status(403).json({
        code: 'invalid_origin',
        message: 'This origin is not allowed.',
      });
    if (req.get('sec-fetch-site') === 'cross-site' && !callback(req))
      return res.status(403).json({
        code: 'cross_site',
        message: 'Cross-site requests are not allowed.',
      });
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      !origin &&
      !req.get('authorization')?.startsWith('Bearer ')
    ) {
      return res.status(403).json({
        code: 'origin_required',
        message: 'Browser writes require an Origin header.',
      });
    }
    next();
  });
  app.use((req, res, next) => {
    if (
      options.maintenanceFile &&
      existsSync(options.maintenanceFile) &&
      (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) || callback(req))
    ) {
      return res.status(503).set('Retry-After', '15').json({
        code: 'maintenance',
        message:
          'The workspace is being updated. Your draft is kept; retry after maintenance finishes.',
      });
    }
    next();
  });
  app.use(express.json({ limit: '2mb' }));
  app.use(legacyRoutes);
  // Mount on the same routes as the handlers, including Express's case/slash rules.
  app.post(
    [
      '/api/auth/setup',
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/entra/start',
    ],
    authenticationLimiter(),
  );
  const signIn = (
    res: Response,
    user: Parameters<Store['session']>[0],
    method: 'password' | 'entra' = 'password',
    redirect = false,
  ) => {
    res.cookie('pw_session', store.session(user, method), {
      httpOnly: true,
      sameSite: 'strict',
      secure: options.secureCookies ?? false,
      maxAge: (method === 'entra' ? 8 : 7 * 24) * 3600000,
      path: '/',
    });
    return redirect ? res.redirect(303, '/') : res.json({ user });
  };
  app.get('/livez', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', (_req, res) => {
    try {
      store.db.prepare('SELECT id FROM artifacts LIMIT 1').get();
      const ready =
        !store.needsSetup() &&
        !(options.maintenanceFile && existsSync(options.maintenanceFile));
      res.status(ready ? 200 : 503).json({ ok: ready });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.get('/metrics', async (req, res) => {
    if (!metrics || !options.metricsToken) return res.sendStatus(404);
    const token = req.get('authorization')?.startsWith('Bearer ')
      ? req.get('authorization')!.slice(7)
      : '';
    if (
      !timingSafeEqual(
        Buffer.from(digest(token)),
        Buffer.from(digest(options.metricsToken)),
      )
    )
      return res.sendStatus(401);
    res.type(metrics.contentType).send(await metrics.render());
  });
  app.get('/api/health', (_req, res) => {
    try {
      store.db.prepare('SELECT id FROM artifacts LIMIT 1').get();
      res.json({
        ok: true,
        release: options.release ?? 'development',
        version,
        commit: process.env.SOURCE_COMMIT ?? 'development',
        maintenance:
          !!options.maintenanceFile && existsSync(options.maintenanceFile),
      });
    } catch {
      res.status(503).json({ ok: false, code: 'database_unavailable' });
    }
  });
  app.get('/api/auth/status', (req, res) =>
    res.json({
      needsSetup: store.needsSetup(),
      setupAllowed: options.allowSetup !== false,
      user: browserActor(req)?.user ?? null,
      entraEnabled: !!options.entra,
      requireSso: !!options.requireSso,
    }),
  );
  app.post('/api/auth/setup', async (req, res) => {
    requireThat(
      options.allowSetup !== false,
      403,
      'local_setup_required',
      'Create the first account on the local server before exposing it remotely.',
    );
    return signIn(res, await store.setup(req.body));
  });
  app.post('/api/auth/login', async (req, res) => {
    const user = await store.login(req.body);
    requireThat(
      store.passwordAllowed(user, !!options.requireSso),
      403,
      'sso_required',
      'Use Microsoft sign-in. Local recovery is available to the server operator.',
    );
    return signIn(res, user);
  });
  app.post('/api/auth/register', async (req, res) => {
    requireThat(
      !options.requireSso,
      403,
      'sso_required',
      'Accept this invitation with Microsoft sign-in.',
    );
    return signIn(res, await store.register(req.body));
  });
  app.get('/api/auth/identity', (req, res) => {
    const actor = browserActor(req);
    requireThat(actor, 401, 'unauthorized', 'Sign in first.');
    res.json({ ...store.identityStatus(actor), enabled: !!options.entra });
  });
  app.post('/api/auth/entra/start', async (req, res) => {
    requireThat(
      options.entra,
      404,
      'not_configured',
      'Microsoft sign-in is not configured.',
    );
    const input = z
      .object({
        mode: z.enum(['login', 'link']).default('login'),
        password: z.string().optional(),
        invitation: z.string().min(32).max(128).optional(),
      })
      .parse(req.body);
    let userId: string | undefined;
    if (input.mode === 'link') {
      const actor = browserActor(req);
      requireThat(
        actor,
        401,
        'unauthorized',
        'Sign in before connecting Microsoft.',
      );
      const user = await store.login({
        email: actor.user.email,
        password: input.password,
      });
      requireThat(
        user.id === actor.user.id,
        401,
        'unauthorized',
        'Verify your password.',
      );
      userId = user.id;
    }
    let start;
    try {
      start = await options.entra.start();
    } catch {
      throw new AppError(
        503,
        'identity_unavailable',
        'Microsoft sign-in is unavailable. Try again shortly.',
      );
    }
    const browser = secret();
    store.beginIdentityFlow({
      ...start,
      browser,
      userId,
      session: userId ? sessionCookie(req) : undefined,
      invitation: input.invitation,
    });
    res.cookie('pw_oidc', browser, {
      httpOnly: true,
      sameSite: 'lax',
      secure: options.secureCookies ?? false,
      maxAge: 600000,
      path: '/api/auth/entra',
    });
    res.json({ url: start.url });
  });
  app.get('/api/auth/entra/callback', async (req, res) => {
    try {
      requireThat(
        options.entra,
        404,
        'not_configured',
        'Microsoft sign-in is not configured.',
      );
      const browser =
        req.headers.cookie
          ?.split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('pw_oidc='))
          ?.slice(8) ?? '';
      const state = z.string().min(16).max(256).parse(req.query.state);
      const flow = store.consumeIdentityFlow(state, browser);
      const identity = await options.entra.complete(
        new URL(req.originalUrl, options.entra.options.origin),
        flow,
        state,
      );
      const user = await store.entraSignIn(identity, flow);
      res.clearCookie('pw_oidc', { path: '/api/auth/entra' });
      return signIn(res, user, 'entra', true);
    } catch (error) {
      res.clearCookie('pw_oidc', { path: '/api/auth/entra' });
      const message =
        error instanceof AppError
          ? error.message
          : 'Microsoft sign-in could not be verified. Start again or contact your administrator.';
      return res.redirect(303, '/?signinError=' + encodeURIComponent(message));
    }
  });
  app.post('/api/auth/logout', (req, res) => {
    store.logout(sessionCookie(req));
    res.clearCookie('pw_session', { path: '/' });
    res.json({ ok: true });
  });
  app.post('/api/invitations/inspect', (req, res) =>
    res.json(
      store.inspectInvite(z.string().min(32).max(128).parse(req.body.token)),
    ),
  );
  const authenticate = (req: Request, _res: Response, next: NextFunction) => {
    const bearer = req.get('authorization');
    const actor = bearer?.startsWith('Bearer ')
      ? store.tokenActor(bearer.slice(7))
      : browserActor(req);
    if (!actor)
      return next(
        new AppError(
          401,
          'unauthorized',
          'Sign in or supply a valid agent key.',
        ),
      );
    requireThat(
      actor.token ||
        !req.get('X-Workspace-User') ||
        req.get('X-Workspace-User') === actor.user.id,
      401,
      'session_changed',
      'The signed-in account changed. Sign in again before continuing.',
    );
    _res.locals.actor = actor;
    next();
  };
  app.post('/mcp', authenticate, async (req, res) => {
    requireThat(
      res.locals.actor.token,
      403,
      'agent_key_required',
      'MCP requires a scoped agent key.',
    );
    store.recordAgentUse(res.locals.actor);
    await handleMcp(store, res.locals.actor, req, res);
  });
  app.all('/mcp', (_req, res) =>
    res.status(405).set('Allow', 'POST').json({
      code: 'method_not_allowed',
      message: 'Use Streamable HTTP POST with a Bearer agent key.',
    }),
  );
  app.use('/api', authenticate);
  const actor = (res: Response) => res.locals.actor as Actor;
  app.get('/api/workspaces/:wid/catalog', (req, res) =>
    res.json(store.catalog(actor(res), req.params.wid)),
  );
  app.post('/api/workspaces/:wid/folders', (req, res) =>
    res
      .status(201)
      .json(
        store.createFolder(actor(res), {
          ...req.body,
          workspaceId: req.params.wid,
        }),
      ),
  );
  app.patch('/api/workspaces/:wid/folders/:fid', (req, res) =>
    res.json(
      store.changeFolder(actor(res), {
        ...req.body,
        workspaceId: req.params.wid,
        folderId: req.params.fid,
      }),
    ),
  );
  app.get('/api/search', (req, res) =>
    res.json(
      store.search(actor(res), {
        query: req.query.query,
        workspaceId: req.query.workspaceId,
        includeArchived: req.query.includeArchived === 'true',
      }),
    ),
  );
  app.get('/api/my-reviews', (_req, res) =>
    res.json(store.myReviews(actor(res))),
  );
  app.get('/api/notifications', (_req, res) =>
    res.json(store.notifications(actor(res))),
  );
  app.post('/api/notifications/read', (req, res) =>
    res.json(store.readNotifications(actor(res), req.body)),
  );
  app.patch('/api/artifacts/:did', (req, res) =>
    res.json(
      store.changeArtifact(actor(res), {
        ...req.body,
        artifactId: req.params.did,
      }),
    ),
  );
  app.get('/api/workspaces/:wid/service-accounts', (req, res) =>
    res.json(store.serviceAccounts(actor(res), req.params.wid)),
  );
  app.post('/api/workspaces/:wid/service-accounts', (req, res) =>
    res
      .status(201)
      .json(store.createServiceAccount(actor(res), req.params.wid, req.body)),
  );
  app.post('/api/workspaces/:wid/service-accounts/:sid/tokens', (req, res) =>
    res
      .status(201)
      .json(
        store.createServiceToken(
          actor(res),
          req.params.wid,
          req.params.sid,
          req.body,
        ),
      ),
  );
  app.post('/api/workspaces/:wid/service-accounts/:sid/disable', (req, res) =>
    res.json(
      store.disableServiceAccount(actor(res), req.params.wid, req.params.sid),
    ),
  );
  app.delete(
    '/api/workspaces/:wid/service-accounts/:sid/tokens/:tid',
    (req, res) => {
      store.revokeServiceToken(
        actor(res),
        req.params.wid,
        req.params.sid,
        req.params.tid,
      );
      res.json({ ok: true });
    },
  );
  app.get('/api/organization', (_req, res) =>
    res.json(store.organization(actor(res))),
  );
  app.get('/api/organization/admin', (_req, res) =>
    res.json(store.organizationAdmin(actor(res))),
  );
  app.get('/api/organization/audit', (req, res) =>
    res.json(store.auditLog(actor(res), req.query.before)),
  );
  app.post('/api/organization', (req, res) =>
    res.json(store.updateOrganization(actor(res), req.body)),
  );
  app.post('/api/organization/people/:uid/role', (req, res) =>
    res.json(store.changeOrgRole(actor(res), req.params.uid, req.body)),
  );
  app.post('/api/organization/people/:uid/offboard', (req, res) =>
    res.json(store.offboard(actor(res), req.params.uid, req.body)),
  );
  app.post('/api/organization/people/:uid/reactivate', (req, res) =>
    res.json(store.reactivate(actor(res), req.params.uid, req.body)),
  );
  app.post('/api/organization/teams', (req, res) =>
    res.status(201).json(store.saveTeam(actor(res), null, req.body)),
  );
  app.post('/api/organization/teams/:tid', (req, res) =>
    res.json(store.saveTeam(actor(res), req.params.tid, req.body)),
  );
  app.delete('/api/organization/teams/:tid', (req, res) =>
    res.json(store.deleteTeam(actor(res), req.params.tid, req.body)),
  );
  app.post('/api/organization/credentials/:tid/revoke', (req, res) =>
    res.json(store.revokeOrgToken(actor(res), req.params.tid, req.body)),
  );
  app.post('/api/workspaces/:wid/membership', (req, res) =>
    res.json(store.changeMember(actor(res), req.params.wid, req.body)),
  );
  app.post('/api/workspaces/:wid/ownership', (req, res) =>
    res.json(store.transferOwnership(actor(res), req.params.wid, req.body)),
  );
  app.post(
    '/api/artifacts/:did/images',
    express.raw({ type: 'application/octet-stream', limit: '5mb' }),
    (req, res) => {
      res
        .status(201)
        .json(store.uploadImage(actor(res), req.params.did, req.body));
    },
  );
  app.get('/api/images/:iid', (req, res) => {
    const image = store.image(actor(res), req.params.iid);
    res.type(image.mime).send(Buffer.from(image.data));
  });
  app.post('/api/invitations/accept', (req, res) => {
    requireThat(
      !actor(res).token,
      403,
      'session_required',
      'Accept invitations from a browser.',
    );
    res.json(
      store.acceptInvite(
        actor(res).user,
        z.string().min(32).max(128).parse(req.body.token),
      ),
    );
  });
  app.get('/api/workspaces/:wid/reviewers', (req, res) =>
    res.json(store.reviewers(actor(res), req.params.wid)),
  );
  app.get('/api/workspaces/:wid/review-requests', (req, res) =>
    res.json(store.reviewRequests(actor(res), req.params.wid)),
  );
  app.get('/api/artifacts/:did/review-requests', (req, res) => {
    const doc = store.artifact(actor(res), req.params.did);
    res.json(store.reviewRequests(actor(res), doc.workspaceId, doc.id));
  });
  app.get('/api/review-requests/:rid', (req, res) =>
    res.json(store.reviewRequest(actor(res), req.params.rid)),
  );
  app.post('/api/artifacts/:did/review-requests', (req, res) =>
    res.status(201).json(
      store.requestReview(actor(res), {
        ...req.body,
        artifactId: req.params.did,
      }),
    ),
  );
  app.post('/api/review-requests/:rid/renew', (req, res) =>
    res.status(201).json(
      store.renewReviewRequest(actor(res), {
        ...req.body,
        requestId: req.params.rid,
      }),
    ),
  );
  app.post('/api/review-requests/:rid/cancel', (req, res) =>
    res.json(
      store.cancelReviewRequest(actor(res), {
        ...req.body,
        requestId: req.params.rid,
      }),
    ),
  );
  app.get('/api/workspaces', (_req, res) =>
    res.json(store.workspaces(actor(res))),
  );
  app.post('/api/workspaces', (req, res) =>
    res
      .status(201)
      .json(
        store.transaction(() => store.createWorkspace(actor(res), req.body)),
      ),
  );
  app.get('/api/workspaces/:wid/artifacts', (req, res) =>
    res.json(
      store.artifacts(
        actor(res),
        req.params.wid,
        req.query.includeArchived === 'true',
      ),
    ),
  );
  app.post('/api/artifacts', (req, res) =>
    res.status(201).json(store.createArtifact(actor(res), req.body)),
  );
  app.get('/api/artifacts/:did/resolve-link', (req, res) =>
    res.json(store.resolveLink(actor(res), req.params.did, req.query)),
  );
  app.get('/api/artifacts/:did', (req, res) =>
    res.json(store.artifact(actor(res), req.params.did)),
  );
  app.put('/api/artifacts/:did', (req, res) =>
    res.json(
      store.updateArtifact(actor(res), {
        ...req.body,
        artifactId: req.params.did,
      }),
    ),
  );
  app.get('/api/artifacts/:did/revisions', (req, res) =>
    res.json(store.revisions(actor(res), req.params.did)),
  );
  app.get('/api/artifacts/:did/revisions/:rid', (req, res) =>
    res.json(store.revision(actor(res), req.params.did, req.params.rid)),
  );
  app.post('/api/artifacts/:did/restore', (req, res) =>
    res.json(
      store.restore(actor(res), { ...req.body, artifactId: req.params.did }),
    ),
  );
  app.post('/api/artifacts/:did/reviews', (req, res) =>
    res
      .status(201)
      .json(
        store.review(actor(res), { ...req.body, artifactId: req.params.did }),
      ),
  );
  app.get('/api/artifacts/:did/revisions/:rid/feedback', (req, res) =>
    res.json(store.feedback(actor(res), req.params.did, req.params.rid)),
  );
  app.post('/api/comments/:cid/reattach', (req, res) =>
    res.json(
      store.reattachComment(actor(res), {
        ...req.body,
        commentId: req.params.cid,
      }),
    ),
  );
  app.put('/api/comments/:cid', (req, res) =>
    res.json(
      store.editComment(actor(res), {
        ...req.body,
        commentId: req.params.cid,
      }),
    ),
  );
  app.delete('/api/comments/:cid', (req, res) =>
    res.json(
      store.deleteComment(actor(res), {
        ...req.body,
        commentId: req.params.cid,
      }),
    ),
  );
  app.get('/api/artifacts/:did/comments', (req, res) =>
    res.json(store.comments(actor(res), req.params.did)),
  );
  app.post('/api/artifacts/:did/comments', async (req, res) =>
    res.status(201).json(
      await store.addComment(actor(res), {
        ...req.body,
        artifactId: req.params.did,
      }),
    ),
  );
  app.post('/api/comments/:cid/replies', (req, res) =>
    res
      .status(201)
      .json(
        store.reply(actor(res), { ...req.body, commentId: req.params.cid }),
      ),
  );
  app.patch('/api/comments/:cid', (req, res) =>
    res.json(
      store.resolve(actor(res), { ...req.body, commentId: req.params.cid }),
    ),
  );
  app.get('/api/workspaces/:wid/members', (req, res) =>
    res.json(store.members(actor(res), req.params.wid)),
  );
  app.delete('/api/workspaces/:wid/members/:uid', (req, res) => {
    res.json(
      store.changeMember(actor(res), req.params.wid, {
        userId: req.params.uid,
        role: null,
        expectedVersion: req.body?.expectedVersion,
      }),
    );
  });
  app.get('/api/workspaces/:wid/invitations', (req, res) =>
    res.json(store.invites(actor(res), req.params.wid)),
  );
  app.post('/api/workspaces/:wid/invitations', (req, res) =>
    res.status(201).json(store.invite(actor(res), req.params.wid, req.body)),
  );
  app.delete('/api/workspaces/:wid/invitations/:iid', (req, res) => {
    store.revokeInvite(actor(res), req.params.wid, req.params.iid);
    res.json({ ok: true });
  });
  app.get('/api/workspaces/:wid/tokens', (req, res) =>
    res.json(store.tokens(actor(res), req.params.wid)),
  );
  app.post('/api/workspaces/:wid/tokens', (req, res) =>
    res
      .status(201)
      .json(store.createToken(actor(res), req.params.wid, req.body)),
  );
  app.delete('/api/workspaces/:wid/tokens/:tid', (req, res) => {
    store.revokeToken(actor(res), req.params.wid, req.params.tid);
    res.json({ ok: true });
  });
  app.use('/api', (_req, res) =>
    res
      .status(404)
      .json({ code: 'not_found', message: 'API route not found.' }),
  );
  if (options.serveStatic !== false && existsSync(resolve('dist/index.html'))) {
    app.use(
      express.static(resolve('dist'), { index: false, dotfiles: 'deny' }),
    );
    app.get('/{*path}', (_req, res) =>
      res.sendFile('index.html', { root: resolve('dist') }),
    );
  }
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (res.headersSent) return;
      if (error instanceof AppError)
        return res.status(error.status).json({
          code: error.code,
          message: error.message,
          details: error.details,
        });
      if (error instanceof z.ZodError)
        return res.status(400).json({
          code: 'validation_error',
          message: error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; '),
        });
      if (error instanceof SyntaxError)
        return res
          .status(400)
          .json({ code: 'invalid_json', message: 'Invalid JSON request.' });
      if (
        typeof error === 'object' &&
        error &&
        'type' in error &&
        error.type === 'entity.too.large'
      )
        return res
          .status(413)
          .json({ code: 'too_large', message: 'The request is too large.' });
      console.error(
        'Request failed:',
        error instanceof Error ? error.message : 'Unknown error',
      );
      res.status(500).json({
        code: 'internal_error',
        message: 'The operation could not be completed.',
      });
    },
  );
  return app;
}
