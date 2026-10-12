// Compatibility is confined to the boundary; the application uses artifacts.
// Old links and REST clients keep working through the terminology change.
import type { Request, Response, NextFunction } from 'express';
export function legacyFields(value: unknown, toLegacy = false): unknown {
  if (Array.isArray(value)) return value.map((v) => legacyFields(v, toLegacy));
  if (!value || typeof value !== 'object') return value;
  const keys = toLegacy
    ? { artifactId: 'documentId', artifactCount: 'documentCount' }
    : { documentId: 'artifactId', documentCount: 'artifactCount' };
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      keys[key as keyof typeof keys] ?? key,
      legacyFields(v, toLegacy),
    ]),
  );
}
export function legacyRoutes(req: Request, res: Response, next: NextFunction) {
  const oldRoute =
    /^\/api\/(?:documents(?:\/|$)|workspaces\/[^/]+\/documents(?:[/?]|$))/.test(
      req.url,
    );
  if (oldRoute) {
    req.url = req.url.replace('/documents', '/artifacts');
    const json = res.json.bind(res);
    res.json = ((body: unknown) =>
      json(legacyFields(body, true))) as Response['json'];
  }
  if (req.body) req.body = legacyFields(req.body);
  next();
}
