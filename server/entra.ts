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
export interface EntraOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  origin: string;
  testIssuer?: URL;
}
export class Entra {
  private configuration?: Promise<oidc.Configuration>;
  readonly redirectUri: string;
  constructor(readonly options: EntraOptions) {
    z.string().uuid().parse(options.tenantId);
    this.redirectUri = `${options.origin}/api/auth/entra/callback`;
  }
  private config() {
    if (!this.configuration)
      this.configuration = oidc
        .discovery(
          this.options.testIssuer ??
            new URL(
              `https://login.microsoftonline.com/${this.options.tenantId}/v2.0`,
            ),
          this.options.clientId,
          this.options.clientSecret,
          undefined,
          {
            timeout: 10,
            execute: [
              oidc.enableNonRepudiationChecks,
              ...(this.options.testIssuer?.protocol === 'http:'
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
      scope: 'openid profile email',
      response_mode: 'query',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
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
        claims.tid === this.options.tenantId &&
        typeof claims.oid === 'string',
      401,
      'wrong_tenant',
      'Sign in with an account in the configured organization.',
    );
    return {
      tenantId: this.options.tenantId,
      objectId: z.string().uuid().parse(claims.oid),
      name: typeof claims.name === 'string' ? claims.name : undefined,
      email:
        typeof claims.email === 'string'
          ? claims.email
          : typeof claims.preferred_username === 'string'
            ? claims.preferred_username
            : undefined,
    };
  }
}
export function entraFromEnvironment(origin: string) {
  const tenantId = process.env.ENTRA_TENANT_ID,
    clientId = process.env.ENTRA_CLIENT_ID,
    clientSecret = readSecret('ENTRA_CLIENT_SECRET');
  if (!tenantId && !clientId && !clientSecret) return undefined;
  if (!tenantId || !clientId || !clientSecret || !origin.startsWith('https://'))
    throw new Error(
      'Entra requires ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET (or _FILE), and an HTTPS APP_ORIGIN.',
    );
  z.string().uuid().parse(clientId);
  return new Entra({ tenantId, clientId, clientSecret, origin });
}
