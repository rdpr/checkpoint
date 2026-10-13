// A local protocol peer: real discovery, PKCE, token exchange and RSA-signed ID tokens.
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
export const tenantId = '11111111-1111-4111-8111-111111111111';
export const clientId = '22222222-2222-4222-8222-222222222222';
export async function identityProvider(hostname = '127.0.0.1') {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kid: 'test',
    alg: 'RS256',
    use: 'sig',
  };
  const codes = new Map<string, URLSearchParams>();
  const claims: Record<string, unknown> = {
    sub: 'reviewer:alex',
    name: 'Alex Morgan',
    email: 'alex@example.test',
  };
  const behavior = { corruptSignature: false, unavailable: false };
  const requests: { authorization?: URL; logout?: URL } = {};
  let issuer = '';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (behavior.unavailable) return json({ error: 'unavailable' }, 503);
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
        end_session_endpoint: issuer + '/logout',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/logout') {
      requests.logout = url;
      res.writeHead(302, {
        location: url.searchParams.get('post_logout_redirect_uri')!,
      });
      return res.end();
    }
    if (url.pathname === '/authorize') {
      requests.authorization = url;
      const code = randomUUID();
      codes.set(code, url.searchParams);
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { location: redirect.href });
      return res.end();
    }
    if (url.pathname === '/token') {
      let body = '';
      for await (const part of req) body += part;
      const params = new URLSearchParams(body),
        code = params.get('code')!;
      const original = codes.get(code);
      codes.delete(code);
      if (
        req.headers.authorization ||
        !original ||
        params.get('client_secret') !== 'fixture-secret' ||
        params.get('client_id') !== clientId ||
        params.get('redirect_uri') !== original.get('redirect_uri') ||
        createHash('sha256')
          .update(params.get('code_verifier') ?? '')
          .digest('base64url') !== original.get('code_challenge')
      )
        return json({ error: 'invalid_grant' }, 400);
      const encode = (value: unknown) =>
        Buffer.from(JSON.stringify(value)).toString('base64url');
      const payload = encode({
        iss: issuer,
        aud: clientId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: original.get('nonce'),
        ...claims,
      });
      const input = encode({ alg: 'RS256', kid: 'test' }) + '.' + payload;
      const signature = sign('RSA-SHA256', Buffer.from(input), keys.privateKey);
      if (behavior.corruptSignature) signature[0] ^= 1;
      return json({
        access_token: 'unused',
        token_type: 'Bearer',
        expires_in: 300,
        id_token: input + '.' + signature.toString('base64url'),
      });
    }
    json({ error: 'not_found' }, 404);
  }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  issuer = `http://${hostname}:${(server.address() as AddressInfo).port}`;
  return {
    issuer: new URL(issuer),
    claims,
    behavior,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
