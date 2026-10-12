import {
  Registry,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from '@prometheus-io/client';
import { readFileSync, statfsSync } from 'node:fs';
import type { Request, Response, NextFunction } from 'express';
import type { Store } from './store.ts';

export function monitoring(
  store: Store,
  dataDir?: string,
  operationsFile?: string,
) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'workspaces_' });
  const gauge = (name: string, help: string) =>
    new Gauge({ name: `workspaces_${name}`, help, registers: [registry] });
  const database = gauge('database_up', 'Whether a database read succeeds');
  const disk = gauge(
    'disk_available_bytes',
    'Available bytes on the application data filesystem',
  );
  const configured = gauge(
    'backup_monitoring_configured',
    'Whether backup operation status is configured',
  );
  const backup = gauge(
    'backup_last_success_timestamp_seconds',
    'Last verified local backup',
  );
  const attempt = gauge(
    'backup_last_attempt_success',
    'Whether the latest local backup attempt succeeded',
  );
  const restore = gauge(
    'restore_drill_last_success_timestamp_seconds',
    'Last successful restore drill',
  );
  const offsite = gauge(
    'offsite_backup_configured',
    'Whether off-host backup is configured',
  );
  const opsReadable = gauge(
    'operations_status_readable',
    'Whether operation status can be read',
  );
  const requests = new Histogram({
    name: 'workspaces_http_request_duration_seconds',
    help: 'Request duration by bounded route category, method and status class',
    labelNames: ['area', 'method', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });
  function middleware(req: Request, res: Response, next: NextFunction) {
    const start = performance.now();
    res.once('finish', () => {
      if (['/metrics', '/livez', '/readyz', '/api/health'].includes(req.path))
        return;
      const area = req.path.startsWith('/api/auth/')
        ? 'auth'
        : req.path.startsWith('/api/')
          ? 'api'
          : req.path === '/mcp'
            ? 'mcp'
            : 'web';
      const method = [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'HEAD',
        'OPTIONS',
      ].includes(req.method)
        ? req.method
        : 'OTHER';
      requests.observe(
        { area, method, status: `${Math.floor(res.statusCode / 100)}xx` },
        (performance.now() - start) / 1000,
      );
    });
    next();
  }
  async function render() {
    try {
      store.db.prepare('SELECT id FROM documents LIMIT 1').get();
      database.set(1);
    } catch {
      database.set(0);
    }
    try {
      const fs = statfsSync(dataDir ?? '.');
      disk.set(fs.bavail * fs.bsize);
    } catch {
      disk.set(0);
    }
    configured.set(Number(!!operationsFile));
    let status: Record<string, number> = {};
    try {
      if (operationsFile) {
        const parsed = JSON.parse(readFileSync(operationsFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('Invalid operations status');
        status = parsed;
      }
      opsReadable.set(Number(!!operationsFile));
    } catch {
      opsReadable.set(0);
    }
    const number = (key: string) =>
      typeof status[key] === 'number' && Number.isFinite(status[key])
        ? status[key]
        : 0;
    backup.set(number('backup_last_success'));
    attempt.set(number('backup_last_attempt_success'));
    restore.set(number('restore_drill_last_success'));
    // Off-host backup copies are configured and monitored by the operator.
    offsite.set(0);
    return registry.metrics();
  }
  return { middleware, render, contentType: registry.contentType };
}
