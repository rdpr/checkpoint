import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { Store } from './store.ts';
import { createApp } from './app.ts';
import { entraFromEnvironment, readSecret } from './entra.ts';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be a valid TCP port.');
const host = process.env.HOST ?? '127.0.0.1';
const local = host === '127.0.0.1' || host === '::1' || host === 'localhost';
const origin = process.env.APP_ORIGIN ?? `http://localhost:${port}`;
if (!local && !process.env.APP_ORIGIN)
  throw new Error(
    'Set APP_ORIGIN to the public HTTPS origin when binding to a network interface.',
  );
if (!local && !origin.startsWith('https://'))
  throw new Error(
    'Remote access requires an HTTPS APP_ORIGIN and a TLS reverse proxy.',
  );
if (
  process.env.NODE_ENV === 'production' &&
  !existsSync(resolve('dist/index.html'))
)
  throw new Error(
    'Production frontend is missing. Build this release before starting it.',
  );
const entra = entraFromEnvironment(origin);
const requireSso = process.env.AUTH_MODE === 'entra';
if (
  process.env.AUTH_MODE &&
  !['optional', 'entra'].includes(process.env.AUTH_MODE)
)
  throw new Error('AUTH_MODE must be optional or entra.');
if (requireSso && !entra)
  throw new Error('AUTH_MODE=entra requires Entra configuration.');
const metricsToken = readSecret('METRICS_TOKEN');
if (metricsToken && metricsToken.length < 32)
  throw new Error('METRICS_TOKEN must contain at least 32 characters.');
const store = new Store(
  resolve(process.env.DATA_DIR ?? '.data', 'workspaces.sqlite'),
);
const app = createApp(store, {
  entra,
  requireSso,
  metricsToken,
  dataDir: resolve(process.env.DATA_DIR ?? '.data'),
  operationsFile: process.env.OPERATIONS_STATUS_FILE,
  origins: local
    ? [
        origin,
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        'http://127.0.0.1:5173',
        'http://localhost:5173',
      ]
    : [origin],
  secureCookies: origin.startsWith('https://'),
  allowSetup: local && process.env.NODE_ENV !== 'production',
  release: process.env.APP_RELEASE,
  maintenanceFile: process.env.MAINTENANCE_FILE,
});
const server = app.listen(port, host, () =>
  console.log(
    `Checkpoint: ${origin}\n${store.needsSetup() ? 'Open the local app to create the first account.' : 'Ready.'}`,
  ),
);
const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
