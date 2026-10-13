import * as oidc from 'openid-client';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { requireThat } from './security.ts';

export function readSecret(name: string) {
  const file = process.env[`${name}_FILE`];
  if (file && process.env[name])
    throw new Error(`Set either ${name} or ${name}_FILE, not both.`);
  return (
    (file ? readFileSync(file, 'utf8') : process.env[name])?.trim() || undefined
  );
}

// Only this exact Microsoft authority can bridge historical tenant/object links.
export function entraTenant(issuer: string) {
  const match =
    /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]+)\/v2\.0$/.exec(issuer);
  return match && z.string().uuid().safeParse(match[1]).success
    ? match[1]
    : undefined;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  name?: string;
  email?: string;
  legacyEntra?: { tenantId: string; objectId: string };
}
export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret: string;
  origin: string;
  scopes?: string;
  prompt?: string;
  logoutRedirect?: boolean;
  redirectPath?: string;
  /** Only for the local HTTP identity provider used by integration tests. */
  allowInsecureRequests?: boolean;
}
export class Oidc {
  private configuration?: Promise<oidc.Configuration>;
  readonly redirectUri: string;
  constructor(readonly options: OidcOptions) {
    const issuer = new URL(options.issuer);
    if (
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password ||
      (issuer.protocol !== 'https:' &&
        !(options.allowInsecureRequests && issuer.protocol === 'http:'))
    )
      throw new Error(
        'OIDC_ISSUER must be an HTTPS issuer URL without credentials, query or fragment.',
      );
    if (
      !(options.scopes ?? 'openid profile email')
        .split(/\s+/)
        .includes('openid')
    )
      throw new Error('OIDC_SCOPES must include openid.');
    this.redirectUri = `${options.origin}${options.redirectPath ?? '/api/auth/oidc/callback'}`;
  }
  private config() {
    if (!this.configuration)
      this.configuration = oidc
        .discovery(
          new URL(this.options.issuer),
          this.options.clientId,
          this.options.clientSecret,
          oidc.ClientSecretPost(this.options.clientSecret),
          {
            timeout: 10,
            execute: [
              oidc.enableNonRepudiationChecks,
              ...(this.options.allowInsecureRequests
                ? [oidc.allowInsecureRequests]
                : []),
            ],
          },
        )
        .catch((error) => {
          this.configuration = undefined;
          throw error;
        });
    return this.configuration;
  }
  async start() {
    const config = await this.config();
    const state = oidc.randomState(),
      nonce = oidc.randomNonce(),
      verifier = oidc.randomPKCECodeVerifier();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: this.options.scopes ?? 'openid profile email',
      response_mode: 'query',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      ...(this.options.prompt?.trim()
        ? { prompt: this.options.prompt.trim() }
        : {}),
    });
    return { url: url.href, state, nonce, verifier };
  }
  async complete(
    url: URL,
    flow: { verifier: string; nonce: string },
    state: string,
  ) {
    const tokens = await oidc.authorizationCodeGrant(await this.config(), url, {
      pkceCodeVerifier: flow.verifier,
      expectedState: state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    requireThat(
      claims &&
        claims.iss === this.options.issuer &&
        typeof claims.sub === 'string' &&
        claims.sub.length > 0,
      401,
      'invalid_identity',
      'The identity provider did not return a valid issuer and subject.',
    );
    const tenantId = entraTenant(claims.iss);
    const identity: OidcIdentity = {
      issuer: claims.iss,
      subject: claims.sub,
      name: typeof claims.name === 'string' ? claims.name : undefined,
      email:
        typeof claims.email === 'string'
          ? claims.email
          : typeof claims.preferred_username === 'string'
            ? claims.preferred_username
            : undefined,
      ...(tenantId &&
      claims.tid === tenantId &&
      z.string().uuid().safeParse(claims.oid).success
        ? { legacyEntra: { tenantId, objectId: claims.oid as string } }
        : {}),
    };
    return { ...identity, idToken: tokens.id_token! };
  }
  async logoutUrl(identity?: { issuer: string; idToken: string }) {
    if (
      !this.options.logoutRedirect ||
      identity?.issuer !== this.options.issuer
    )
      return undefined;
    return oidc.buildEndSessionUrl(await this.config(), {
      id_token_hint: identity.idToken,
      post_logout_redirect_uri: `${this.options.origin}/`,
    }).href;
  }
}

export function oidcFromEnvironment(origin: string) {
  const issuer = process.env.OIDC_ISSUER,
    clientId = process.env.OIDC_CLIENT_ID,
    clientSecret = readSecret('OIDC_CLIENT_SECRET');
  const hasOidc =
    !!clientSecret ||
    Object.entries(process.env).some(
      ([key, value]) =>
        key.startsWith('OIDC_') && value && key !== 'OIDC_CLIENT_SECRET_FILE',
    );
  const legacySecret = readSecret('ENTRA_CLIENT_SECRET');
  const hasEntra = !!(
    process.env.ENTRA_TENANT_ID ||
    process.env.ENTRA_CLIENT_ID ||
    legacySecret
  );
  if (hasOidc && hasEntra)
    throw new Error('Do not mix OIDC_* and legacy ENTRA_* configuration.');
  if (!hasOidc && !clientSecret && !hasEntra) return undefined;
  const tenantId = hasEntra
    ? z.string().uuid().parse(process.env.ENTRA_TENANT_ID)
    : undefined;
  const resolvedIssuer = tenantId
    ? `https://login.microsoftonline.com/${tenantId}/v2.0`
    : issuer;
  const resolvedClient = tenantId ? process.env.ENTRA_CLIENT_ID : clientId;
  const resolvedSecret = tenantId ? legacySecret : clientSecret;
  if (
    !resolvedIssuer ||
    !resolvedClient ||
    !resolvedSecret ||
    new URL(origin).protocol !== 'https:'
  )
    throw new Error(
      'OIDC requires OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET (or _FILE), and an HTTPS APP_ORIGIN.',
    );
  if (
    process.env.OIDC_LOGOUT_REDIRECT &&
    !['true', 'false'].includes(process.env.OIDC_LOGOUT_REDIRECT)
  )
    throw new Error('OIDC_LOGOUT_REDIRECT must be true or false.');
  return new Oidc({
    issuer: resolvedIssuer,
    clientId: resolvedClient,
    clientSecret: resolvedSecret,
    origin,
    scopes: process.env.OIDC_SCOPES || undefined,
    prompt: tenantId ? 'select_account' : process.env.OIDC_PROMPT,
    logoutRedirect: process.env.OIDC_LOGOUT_REDIRECT === 'true',
    redirectPath: tenantId ? '/api/auth/entra/callback' : undefined,
  });
}
