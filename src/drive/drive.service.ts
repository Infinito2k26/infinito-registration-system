import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'crypto';
import { AppConfig } from '../config/app-config.service';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface DriveFile {
  contentType: string;
  data: Buffer;
}

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = /^(image\/(jpeg|png|webp|gif|heic|heif)|application\/pdf)$/;
const CACHE_TTL_MS = 10 * 60 * 1000;
/** Total bytes kept in memory; ID scans can be several MB each. */
const CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Reads form uploads (photos, ID cards) from Google Drive with a service account,
 * so the files stay private and are only ever served to signed-in staff.
 * Setup: share the form's upload folder with the service account's email as Viewer.
 */
@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);
  private readonly account: ServiceAccount | null;
  private accessToken: { value: string; expiresAt: number } | null = null;
  /** Small LRU so gate volunteers re-opening the same pass don't hit Drive each time. */
  private readonly cache = new Map<string, { file: DriveFile; at: number }>();
  private cacheBytes = 0;

  constructor(config: AppConfig) {
    const json = config.googleServiceAccountJson;
    let account: ServiceAccount | null = null;
    if (json) {
      try {
        account = JSON.parse(json) as ServiceAccount;
      } catch {
        this.logger.error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON; photos/IDs disabled');
      }
    } else {
      this.logger.warn('GOOGLE_SERVICE_ACCOUNT_JSON not set; participant photos/IDs are not shown');
    }
    this.account = account;
  }

  get enabled() {
    return this.account !== null;
  }

  /** Never throws: missing, inaccessible or unsupported files (and Drive outages) return null. */
  async fetchFile(fileId: string): Promise<DriveFile | null> {
    if (!this.account || !/^[\w-]{10,200}$/.test(fileId)) return null;
    try {
      return await this.fetchFromDrive(fileId);
    } catch (error) {
      this.logger.warn(`Drive file ${fileId} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async fetchFromDrive(fileId: string): Promise<DriveFile | null> {
    const cached = this.cache.get(fileId);
    if (cached) {
      this.cache.delete(fileId);
      if (Date.now() - cached.at < CACHE_TTL_MS) {
        this.cache.set(fileId, cached); // re-insert = most recently used
        return cached.file;
      }
      this.cacheBytes -= cached.file.data.length;
    }

    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) {
      this.logger.warn(`Drive file ${fileId}: HTTP ${res.status}`);
      return null;
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!ALLOWED_TYPES.test(contentType)) {
      this.logger.warn(`Drive file ${fileId}: refusing content type ${contentType}`);
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_BYTES) return null;

    const file = { contentType, data };
    this.cache.set(fileId, { file, at: Date.now() });
    this.cacheBytes += data.length;
    for (const [key, entry] of this.cache) {
      if (this.cacheBytes <= CACHE_MAX_BYTES) break;
      this.cache.delete(key);
      this.cacheBytes -= entry.file.data.length;
    }
    return file;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;

    const account = this.account!;
    const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const encode = (obj: object) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url');

    const res = await fetch(tokenUri, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${unsigned}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`Google token request failed: HTTP ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}
