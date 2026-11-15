/**
 * Connector gateway — third-party services behind scoped credentials, the
 * pattern all four studied agents shared (skills/plugins/connect).
 *
 * Design rules honored here:
 *  - Connectors are declared, not discovered; calls are shape-checked.
 *  - Credentials live in an encrypted vault (AES-256-GCM, key from
 *    OPENCLICKY_VAULT_KEY), never in the model context.
 *  - Calls are scope-enforced: must stay on the connector's origin and under
 *    its allowed path prefixes. The model cannot coax the gateway elsewhere.
 *  - connector.connect / connector.call are ASK_ONCE: linking an account and
 *    the first calls ask; an "always" grant then covers repeat usage.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  Args,
  CapabilitySnapshot,
  Card,
  CommandResult,
  CommandSpec,
  InvokeCommand,
} from '../types.js';
import type { Runtime } from '../registry.js';

/* ---------------- connector specs ---------------- */

export type ConnectorAuth =
  | { type: 'apiKey'; /** header name (default "authorization") */ header?: string; /** value prefix (default "Bearer ") */ prefix?: string }
  | { type: 'oauth2'; authorizeUrl: string; tokenUrl: string; clientId: string; scopes: string[] };

export interface ConnectorSpec {
  id: string; // "github", "gmail", ...
  name: string;
  description: string;
  baseUrl: string; // https://api.github.com
  /** Allowed URL path prefixes (default: all paths under baseUrl). */
  allowedPaths?: string[];
  auth: ConnectorAuth;
}

/* ---------------- token vault ---------------- */

interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  obtainedAtMs: number;
}

export interface TokenVault {
  get(connectorId: string): StoredToken | undefined;
  set(connectorId: string, token: StoredToken): void;
  delete(connectorId: string): void;
}

export class InMemoryTokenVault implements TokenVault {
  private tokens = new Map<string, StoredToken>();
  get(id: string): StoredToken | undefined {
    return this.tokens.get(id);
  }
  set(id: string, token: StoredToken): void {
    this.tokens.set(id, token);
  }
  delete(id: string): void {
    this.tokens.delete(id);
  }
}

/** AES-256-GCM file vault; key derived from a user-supplied passphrase. */
export class FileTokenVault implements TokenVault {
  constructor(
    private file: string = process.env.OPENCLICKY_VAULT_PATH ?? path.join(os.homedir(), '.openclicky', 'vault.json'),
    private passphrase: string | undefined = process.env.OPENCLICKY_VAULT_KEY,
  ) {}

  private load(): Record<string, StoredToken> {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      if (!this.passphrase) throw new Error('OPENCLICKY_VAULT_KEY required for the file vault');
      const { iv, tag, ciphertext } = JSON.parse(raw) as { iv: string; tag: string; ciphertext: string };
      const key = crypto.createHash('sha256').update(this.passphrase).digest();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as Record<string, StoredToken>;
    } catch {
      return {};
    }
  }

  private save(tokens: Record<string, StoredToken>): void {
    if (!this.passphrase) throw new Error('OPENCLICKY_VAULT_KEY required for the file vault');
    const key = crypto.createHash('sha256').update(this.passphrase).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(
      this.file,
      JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }),
      { mode: 0o600 },
    );
  }

  get(id: string): StoredToken | undefined {
    return this.load()[id];
  }
  set(id: string, token: StoredToken): void {
    const all = this.load();
    all[id] = token;
    this.save(all);
  }
  delete(id: string): void {
    const all = this.load();
    delete all[id];
    this.save(all);
  }
}

/* ---------------- the runtime ---------------- */

const SPECS: CommandSpec[] = [
  {
    id: 'connector.list',
    version: 'v1',
    title: 'List connectors',
    description: 'Shows available connectors and whether each is connected.',
    args: [],
    defaultApproval: 'AUTO',
  },
  {
    id: 'connector.connect',
    version: 'v1',
    title: 'Connect an account',
    description: 'Links a connector: "secret" for API-key connectors; OAuth connectors return an authorize URL first — open it, approve, then call again with "code".',
    args: [
      { name: 'connectorId', type: 'string', description: 'Connector id from connector.list', required: true },
      { name: 'secret', type: 'string', description: 'API key / token (API-key connectors)', required: false },
      { name: 'code', type: 'string', description: 'OAuth authorization code (second step)', required: false },
    ],
    defaultApproval: 'ASK_ONCE',
  },
  {
    id: 'connector.call',
    version: 'v1',
    title: 'Call a connector API',
    description: 'Makes an HTTP request to a connected service, scoped to its base URL and allowed paths.',
    args: [
      { name: 'connectorId', type: 'string', description: 'Connector id', required: true },
      { name: 'path', type: 'string', description: 'Path under the connector base URL (e.g. "/user/repos")', required: true },
      { name: 'method', type: 'enum', description: 'HTTP method (default GET)', enumValues: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], required: false },
      { name: 'body', type: 'string', description: 'JSON body for write methods', required: false },
    ],
    defaultApproval: 'ASK_ONCE',
  },
];

interface PendingOAuth {
  verifier: string;
  state: string;
}

export interface ConnectorGatewayOptions {
  runtimeId?: string;
  connectors: ConnectorSpec[];
  vault?: TokenVault;
  fetchFn?: typeof fetch; // injectable for tests
}

export class ConnectorGateway implements Runtime {
  readonly runtimeId: string;
  private connectors: Map<string, ConnectorSpec>;
  private vault: TokenVault;
  private fetchFn: typeof fetch;
  private pending = new Map<string, PendingOAuth>();

  constructor(opts: ConnectorGatewayOptions) {
    this.runtimeId = opts.runtimeId ?? 'connectors';
    this.connectors = new Map(opts.connectors.map((c) => [c.id, c]));
    this.vault = opts.vault ?? new InMemoryTokenVault();
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async snapshot(): Promise<CapabilitySnapshot> {
    return {
      runtimeId: this.runtimeId,
      runtimeKind: 'connector',
      protocolVersion: '1',
      commands: SPECS,
      dataSources: [],
      triggers: [],
    };
  }

  async invoke(cmd: InvokeCommand): Promise<CommandResult> {
    try {
      switch (cmd.commandId) {
        case 'connector.list': {
          const lines = this.all().map(
            (c) => `${c.id} — ${c.name} (${c.auth.type === 'oauth2' ? 'OAuth' : 'API key'}${this.vault.get(c.id) ? ', connected' : ''}): ${c.description}`,
          );
          return okText(cmd, lines.join('\n') || 'no connectors configured');
        }
        case 'connector.connect':
          return this.connect(cmd);
        case 'connector.call':
          return this.call(cmd);
        default:
          throw new Error(`unknown connector command: ${cmd.commandId}`);
      }
    } catch (err) {
      return { invocationId: cmd.invocationId, ok: false, error: { code: 500, message: (err as Error).message, retryable: false } };
    }
  }

  all(): ConnectorSpec[] {
    return [...this.connectors.values()];
  }

  private connect(cmd: InvokeCommand): Promise<CommandResult> | CommandResult {
    const id = strArg(cmd, 'connectorId');
    const spec = this.connectors.get(id);
    if (!spec) return okText(cmd, `unknown connector "${id}" — see connector.list`);

    if (spec.auth.type === 'apiKey') {
      const secret = strArg(cmd, 'secret');
      if (!secret) return okText(cmd, `${spec.name} needs an API key: call connector.connect with the "secret" arg`);
      this.vault.set(id, { accessToken: secret, obtainedAtMs: Date.now() });
      return okText(cmd, `connected to ${spec.name} (API key stored in the vault)`);
    }

    // OAuth2: step 1 → authorize URL; step 2 (with code) → token exchange.
    const code = strArg(cmd, 'code');
    if (!code) {
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      const state = crypto.randomBytes(16).toString('base64url');
      this.pending.set(id, { verifier, state });
      const url =
        `${spec.auth.authorizeUrl}?response_type=code&client_id=${encodeURIComponent(spec.auth.clientId)}` +
        `&redirect_uri=${encodeURIComponent('urn:ietf:wg:oauth:2.0:oob')}` +
        `&scope=${encodeURIComponent(spec.auth.scopes.join(' '))}&state=${state}` +
        `&code_challenge=${challenge}&code_challenge_method=S256`;
      const cards: Card[] = [{ kind: 'link', json: JSON.stringify({ url, title: `Authorize ${spec.name}` }) }];
      return {
        invocationId: cmd.invocationId,
        ok: true,
        data: { kind: 'string', value: `Open this URL to authorize ${spec.name}, then call connector.connect again with the "code" you receive:\n${url}` },
        cards,
      };
    }
    return this.exchangeCode(spec, code, cmd);
  }

  private async exchangeCode(spec: ConnectorSpec, code: string, cmd: InvokeCommand): Promise<CommandResult> {
    const pending = this.pending.get(spec.id);
    if (!pending) return okText(cmd, `no pending OAuth flow for ${spec.name} — call connector.connect without a code first`);
    const res = await this.fetchFn(spec.auth.type === 'oauth2' ? spec.auth.tokenUrl : '', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: spec.auth.type === 'oauth2' ? spec.auth.clientId : '',
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        code_verifier: pending.verifier,
      }).toString(),
    });
    if (!res.ok) {
      return { invocationId: cmd.invocationId, ok: false, error: { code: res.status, message: `token exchange failed: ${res.status}`, retryable: true } };
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string };
    if (!data.access_token) {
      return { invocationId: cmd.invocationId, ok: false, error: { code: 502, message: 'token endpoint returned no access_token', retryable: false } };
    }
    this.vault.set(spec.id, { accessToken: data.access_token, refreshToken: data.refresh_token, obtainedAtMs: Date.now() });
    this.pending.delete(spec.id);
    return okText(cmd, `connected to ${spec.name} via OAuth`);
  }

  private async call(cmd: InvokeCommand): Promise<CommandResult> {
    const id = strArg(cmd, 'connectorId');
    const spec = this.connectors.get(id);
    if (!spec) return okText(cmd, `unknown connector "${id}" — see connector.list`);
    const token = this.vault.get(id);
    if (!token) return okText(cmd, `${spec.name} is not connected yet — call connector.connect first`);

    const target = this.scopeChecked(spec, strArg(cmd, 'path'));
    if (target === null) {
      return { invocationId: cmd.invocationId, ok: false, error: { code: 403, message: `path is outside ${spec.name}'s allowed scope`, retryable: false } };
    }

    const method = strArg(cmd, 'method') ?? 'GET';
    const body = strArg(cmd, 'body');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (spec.auth.type === 'apiKey') {
      const headerName = spec.auth.header ?? 'authorization';
      const prefix = spec.auth.prefix === undefined ? 'Bearer ' : spec.auth.prefix;
      headers[headerName] = `${prefix}${token.accessToken}`;
    } else {
      headers.authorization = `Bearer ${token.accessToken}`;
    }
    if (body) headers['content-type'] = 'application/json';

    const res = await this.fetchFn(target, { method, headers, body });
    const text = await res.text();
    if (!res.ok) {
      return { invocationId: cmd.invocationId, ok: false, error: { code: res.status, message: `${spec.name} call failed (${res.status}): ${text.slice(0, 300)}`, retryable: res.status >= 500 } };
    }
    return okText(cmd, text.slice(0, 6000));
  }

  /** Scope rule: same origin as baseUrl AND under an allowed path prefix. */
  private scopeChecked(spec: ConnectorSpec, relPath: string): string | null {
    let base: URL;
    let target: URL;
    try {
      base = new URL(spec.baseUrl);
      target = new URL(relPath, spec.baseUrl.endsWith('/') ? spec.baseUrl : spec.baseUrl + '/');
    } catch {
      return null;
    }
    if (target.origin !== base.origin) return null;
    const allowed = spec.allowedPaths ?? ['/'];
    if (!allowed.some((prefix) => target.pathname.startsWith(prefix))) return null;
    return target.toString();
  }

  static specs(): CommandSpec[] {
    return SPECS;
  }
}

function okText(cmd: InvokeCommand, text: string): CommandResult {
  return { invocationId: cmd.invocationId, ok: true, data: { kind: 'string', value: text } };
}

function strArg(cmd: InvokeCommand, name: string): string {
  const v = (cmd.args as Args)[name];
  return v?.kind === 'string' ? v.value : '';
}
