import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.ts';
import { Entra } from '../server/entra.ts';
import { identityProvider, tenantId, clientId } from './oidc-provider.ts';
import { createApp } from '../server/app.ts';
const directory = mkdtempSync(join(tmpdir(), 'pw-browser-'));
const store = new Store(join(directory, 'db.sqlite'));
const provider = await identityProvider();
const server = createApp(store, {
  origins: ['http://127.0.0.1:4411'],
  entra: new Entra({
    tenantId,
    clientId,
    clientSecret: 'fixture-secret',
    origin: 'http://127.0.0.1:4411',
    testIssuer: provider.issuer,
  }),
}).listen(4411, '127.0.0.1');
function stop() {
  server.closeAllConnections();
  server.close(async () => {
    await provider.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
