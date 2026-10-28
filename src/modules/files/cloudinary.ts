import { createHash } from 'node:crypto';
import type { AppConfig } from '../../config/config.schema.js';

type CloudinaryConfig = NonNullable<AppConfig['cloudinary']>;

export type StoredFile = { publicId: string; bytes: number; resourceType: 'raw' | 'image' };

/**
 * Cloudinary as the file store (TECH-SPEC 5.8). Receipts, statements and backups are uploaded as
 * `authenticated` (private) and opened only through short-lived signed links. Calls are signed with
 * CLOUDINARY_API_SECRET on the server; the app never sees it.
 */
export class FileStore {
  constructor(
    private readonly config: CloudinaryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private sign(params: Record<string, string | number>): string {
    const base = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return createHash('sha1')
      .update(base + this.config.apiSecret)
      .digest('hex');
  }

  private folder(path: string): string {
    return this.config.folder ? `${this.config.folder}/${path}` : path;
  }

  private api(path: string) {
    return `https://api.cloudinary.com/v1_1/${this.config.cloudName}/${path}`;
  }

  /** Uploads a private file at `path` (for example "backups/2026-10-28"). */
  async upload(path: string, content: Buffer, resourceType: 'raw' | 'image' = 'raw'): Promise<StoredFile> {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { public_id: this.folder(path), timestamp, type: 'authenticated', overwrite: 'true' };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.set(k, String(v));
    form.set('api_key', this.config.apiKey);
    form.set('signature', this.sign(params));
    form.set('file', `data:application/octet-stream;base64,${content.toString('base64')}`);
    const res = await this.fetchImpl(this.api(`${resourceType}/upload`), { method: 'POST', body: form });
    if (!res.ok) throw new Error(`cloudinary_upload_${res.status}`);
    const body = (await res.json()) as { public_id: string; bytes: number };
    return { publicId: body.public_id, bytes: body.bytes, resourceType };
  }

  /** A link that opens the private file for `seconds` (default 10 minutes). */
  signedUrl(publicId: string, resourceType: 'raw' | 'image' = 'raw', seconds = 600): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { public_id: publicId, timestamp, type: 'authenticated', expires_at: timestamp + seconds };
    const q = new URLSearchParams({
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      api_key: this.config.apiKey,
      signature: this.sign(params),
    });
    return `${this.api(`${resourceType}/download`)}?${q.toString()}`;
  }

  /** Downloads a private file's bytes on the server (restore checks, statement parsing). */
  async download(publicId: string, resourceType: 'raw' | 'image' = 'raw'): Promise<Buffer> {
    const res = await this.fetchImpl(this.signedUrl(publicId, resourceType, 120));
    if (!res.ok) throw new Error(`cloudinary_download_${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async destroy(publicId: string, resourceType: 'raw' | 'image' = 'raw'): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { public_id: publicId, timestamp, type: 'authenticated' };
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.set(k, String(v));
    form.set('api_key', this.config.apiKey);
    form.set('signature', this.sign(params));
    const res = await this.fetchImpl(this.api(`${resourceType}/destroy`), { method: 'POST', body: form });
    if (!res.ok) throw new Error(`cloudinary_destroy_${res.status}`);
  }

  /** Private files under a folder, oldest first (Admin API), for the 30-day backup window. */
  async list(prefix: string, resourceType: 'raw' | 'image' = 'raw'): Promise<{ publicId: string; createdAt: Date }[]> {
    const auth = Buffer.from(`${this.config.apiKey}:${this.config.apiSecret}`).toString('base64');
    const q = new URLSearchParams({ prefix: this.folder(prefix), max_results: '500', type: 'authenticated' });
    const res = await this.fetchImpl(`${this.api(`resources/${resourceType}/authenticated`)}?${q.toString()}`, {
      headers: { authorization: `Basic ${auth}` },
    });
    if (!res.ok) throw new Error(`cloudinary_list_${res.status}`);
    const body = (await res.json()) as { resources: { public_id: string; created_at: string }[] };
    return body.resources
      .map((r) => ({ publicId: r.public_id, createdAt: new Date(r.created_at) }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
}

export function fileStoreFor(config: AppConfig): FileStore | null {
  return config.cloudinary ? new FileStore(config.cloudinary) : null;
}
