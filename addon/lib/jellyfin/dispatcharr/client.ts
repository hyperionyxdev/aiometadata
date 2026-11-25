// SPDX-License-Identifier: FSL-1.1-ALv2
// Copyright (C) 2026 cedya77 and AIOMetadata contributors, see NOTICE
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import type { DispatcharrSettings } from './settings';

// A day of a big guide runs to tens of megabytes; past this an answer is refused rather than held.
const MAX_BYTES = 128 * 1024 * 1024;
// Access tokens last 30 minutes; they're renewed a little before.
const ACCESS_LIFETIME_MS = 25 * 60 * 1000;

export class DispatcharrError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

interface Answer {
  status: number;
  text: string;
}

/** The Host header to send in place of the address's own: Dispatcharr refuses a name with an underscore. */
export function hostHeaderFor(url: URL, override?: string): string | undefined {
  if (override) return override;
  if (!url.hostname.includes('_')) return undefined;
  return url.port ? `localhost:${url.port}` : 'localhost';
}

/**
 * Dispatcharr's REST API, signed in with an API key, or with a username and password (a JWT that is
 * refreshed, and asked for again once its refresh token has run out). Node's own http module is used
 * so the Host header can be set. Errors name the path only: no address, query or token.
 */
export class DispatcharrClient {
  private access: string | null = null;
  private refresh: string | null = null;
  private accessUntil = 0;
  private signingIn: Promise<void> | null = null;

  constructor(private readonly settings: DispatcharrSettings) {}

  private send(path: string, init: { method?: string; json?: unknown; auth?: string } = {}): Promise<Answer> {
    const url = new URL(this.settings.url + path);
    const body = init.json === undefined ? undefined : JSON.stringify(init.json);
    const headers: Record<string, string | number> = { accept: 'application/json', 'accept-encoding': 'gzip', 'user-agent': 'AIOMetadata' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      // Sent with its length: some proxies in front of Dispatcharr drop a chunked body.
      headers['content-length'] = Buffer.byteLength(body);
    }
    if (init.auth) Object.assign(headers, this.settings.apiKey ? { 'x-api-key': init.auth } : { authorization: `Bearer ${init.auth}` });
    const host = hostHeaderFor(url, this.settings.hostHeader);
    if (host) headers.host = host;
    const label = url.pathname;
    const timeoutMs = this.settings.timeoutMs;
    return new Promise((resolve, reject) => {
      const client = url.protocol === 'https:' ? https : http;
      let settled = false;
      // Every way a request can end comes through here once: answered, refused, cut off or out of time.
      const finish = (error: DispatcharrError | null, answer?: Answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) {
          req.destroy();
          reject(error);
        } else {
          resolve(answer as Answer);
        }
      };
      const cutOff = (error?: any) => finish(new DispatcharrError(`Dispatcharr ${label} could not be read: ${error?.message || 'the answer was cut off'}`));
      // A deadline for the whole request, answer included: an idle-socket timeout alone never fires
      // once the socket has gone, and a body arriving slowly would never hit it either.
      const deadline = setTimeout(() => finish(new DispatcharrError(`Dispatcharr ${label} gave no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      deadline.unref?.();
      const req = client.request(url, { method: init.method ?? 'GET', headers, timeout: timeoutMs }, (res) => {
        // Piping doesn't pass the response's own failures on to the gunzip stream, so both are watched.
        res.on('error', cutOff);
        res.on('aborted', () => cutOff());
        res.on('close', () => {
          if (!res.complete) cutOff();
        });
        const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
        const chunks: Buffer[] = [];
        let total = 0;
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_BYTES) {
            finish(new DispatcharrError(`Dispatcharr ${label} answered more than ${MAX_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', cutOff);
        stream.on('end', () => finish(null, { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('timeout', () => finish(new DispatcharrError(`Dispatcharr ${label} gave no answer within ${Math.round(timeoutMs / 1000)}s`)));
      req.on('error', (error: any) => finish(error instanceof DispatcharrError ? error : new DispatcharrError(`Dispatcharr ${label} could not be reached (${error?.code || 'error'})`)));
      req.end(body);
    });
  }

  private async signIn(): Promise<void> {
    if (this.refresh) {
      const renewed = await this.send('/api/accounts/token/refresh/', { method: 'POST', json: { refresh: this.refresh } });
      if (renewed.status >= 200 && renewed.status < 300) return this.keep(renewed);
      // Refresh tokens expire after a day; a full sign-in follows.
      this.refresh = null;
    }
    const answer = await this.send('/api/accounts/token/', { method: 'POST', json: { username: this.settings.username, password: this.settings.password } });
    if (answer.status < 200 || answer.status >= 300) throw new DispatcharrError(`Dispatcharr refused the sign-in (${answer.status})`, answer.status);
    this.keep(answer);
  }

  private keep(answer: Answer): void {
    const data = parse(answer.text, '/api/accounts/token/');
    if (typeof data?.access !== 'string') throw new DispatcharrError('Dispatcharr\'s sign-in gave no token');
    this.access = data.access;
    if (typeof data.refresh === 'string') this.refresh = data.refresh;
    this.accessUntil = Date.now() + ACCESS_LIFETIME_MS;
  }

  private async credential(): Promise<string> {
    if (this.settings.apiKey) return this.settings.apiKey;
    if (!this.access || Date.now() > this.accessUntil) {
      // Requests that arrive together share one sign-in.
      this.signingIn ??= this.signIn().finally(() => (this.signingIn = null));
      await this.signingIn;
    }
    return this.access as string;
  }

  /** A signed-in request; a token Dispatcharr no longer takes is dropped and the request made once more. */
  async request(path: string, init: { method?: string; json?: unknown } = {}): Promise<Answer> {
    const answer = await this.send(path, { ...init, auth: await this.credential() });
    if (answer.status === 401 && !this.settings.apiKey) {
      this.access = null;
      return this.send(path, { ...init, auth: await this.credential() });
    }
    return answer;
  }

  async get(path: string): Promise<any> {
    const answer = await this.request(path);
    const label = path.split('?')[0];
    if (answer.status < 200 || answer.status >= 300) throw new DispatcharrError(`Dispatcharr ${label} answered ${answer.status}`, answer.status);
    return parse(answer.text, label);
  }

  /** A list endpoint's rows, paginated or not. */
  async list(path: string): Promise<any[]> {
    const data = await this.get(path);
    return Array.isArray(data) ? data : Array.isArray(data?.results) ? data.results : [];
  }

  /** The live channels an XC login sees, as Dispatcharr's XC output gives them (not signed in: the login is in the query). */
  async xcLiveStreams(xc: { username: string; password: string }): Promise<any[]> {
    const query = new URLSearchParams({ username: xc.username, password: xc.password, action: 'get_live_streams' });
    const answer = await this.send(`/player_api.php?${query}`);
    if (answer.status < 200 || answer.status >= 300) throw new DispatcharrError(`Dispatcharr refused the XC login (${answer.status})`, answer.status);
    const data = parse(answer.text, '/player_api.php');
    if (!Array.isArray(data)) throw new DispatcharrError('Dispatcharr refused the XC login (wrong username or XC password)');
    return data;
  }

  /** The stream each running channel is on, by channel uuid; null when the login may not read it (admin only). */
  async activeStreams(): Promise<Map<string, number> | null> {
    const answer = await this.request('/proxy/ts/status');
    if (answer.status === 401 || answer.status === 403) return null;
    if (answer.status < 200 || answer.status >= 300) throw new DispatcharrError(`Dispatcharr /proxy/ts/status answered ${answer.status}`, answer.status);
    const data = parse(answer.text, '/proxy/ts/status');
    const list: any[] = Array.isArray(data?.channels) ? data.channels : [];
    return new Map(list.filter((c) => c?.channel_id && c.stream_id !== undefined && c.stream_id !== null).map((c) => [String(c.channel_id), Number(c.stream_id)]));
  }

  /** Switches a running channel to one of its streams with Dispatcharr's own switcher (admin only). */
  async changeStream(uuid: string, streamId: number): Promise<void> {
    const answer = await this.request(`/proxy/ts/change_stream/${encodeURIComponent(uuid)}`, { method: 'POST', json: { stream_id: streamId } });
    if (answer.status === 401 || answer.status === 403) throw new DispatcharrError('switching a channel\'s stream needs an admin login', answer.status);
    if (answer.status < 200 || answer.status >= 300) throw new DispatcharrError(`Dispatcharr's switch answered ${answer.status}`, answer.status);
  }
}

function parse(text: string, label: string): any {
  try {
    return JSON.parse(text);
  } catch {
    // An unknown path gets Dispatcharr's web app (HTML) with status 200, so the body is checked.
    throw new DispatcharrError(`Dispatcharr ${label} didn't answer with data (${text.trimStart().startsWith('<') ? 'a web page' : 'unreadable'})`);
  }
}
