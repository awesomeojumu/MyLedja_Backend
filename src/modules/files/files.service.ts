import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../common/errors/errors.js';
import type { WorkspaceContext } from '../../common/workspace/workspace-context.js';
import type { FileStore } from './cloudinary.js';

type MemoryEntry = { bytes: Buffer; resourceType: 'raw' | 'image'; contentType: string };

/**
 * Workspace file uploads and signed view links (TECH-SPEC 5.8).
 * Uses Cloudinary when configured; otherwise an in-memory store so local/tests still exercise the HTTP surface.
 */
export class FilesService {
  private readonly memory = new Map<string, MemoryEntry>();

  constructor(
    private readonly store: FileStore | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upload(
    ctx: WorkspaceContext,
    body: { contentBase64: string; contentType: string; kind: 'receipt' | 'statement' | 'other' },
  ) {
    const buf = Buffer.from(body.contentBase64, 'base64');
    if (buf.length === 0) throw new AppError(400, 'bad_request', 'File content is empty.');
    if (buf.length > 8_000_000) throw new AppError(400, 'bad_request', 'File is too large (max 8 MB).');
    const resourceType: 'raw' | 'image' = body.contentType.startsWith('image/') ? 'image' : 'raw';
    const id = randomUUID();
    const path = `workspaces/${ctx.workspaceId}/${body.kind}/${id}`;

    if (this.store) {
      const saved = await this.store.upload(path, buf, resourceType);
      return { fileId: saved.publicId, bytes: saved.bytes, resourceType: saved.resourceType };
    }

    const fileId = `mem/${path}`;
    this.memory.set(fileId, { bytes: buf, resourceType, contentType: body.contentType });
    return { fileId, bytes: buf.length, resourceType };
  }

  async viewUrl(ctx: WorkspaceContext, fileId: string) {
    const decoded = decodeURIComponent(fileId);
    if (!decoded.includes(ctx.workspaceId) && !decoded.startsWith('mem/')) {
      throw new AppError(404, 'not_found', "That file isn't in this workspace.");
    }
    const expiresAt = new Date(this.now().getTime() + 600_000);

    if (this.store && !decoded.startsWith('mem/')) {
      const resourceType = guessResourceType(decoded);
      const url = this.store.signedUrl(decoded, resourceType, 600);
      return { url, expiresAt: expiresAt.toISOString(), fileId: decoded };
    }

    const entry = this.memory.get(decoded);
    if (!entry) throw new AppError(404, 'not_found', "That file isn't in this workspace.");
    const token = createHash('sha256').update(`${decoded}:${expiresAt.toISOString()}`).digest('hex').slice(0, 16);
    const dataUrl = `data:${entry.contentType};base64,${entry.bytes.toString('base64')}`;
    // data: URLs are valid for in-app preview when Cloudinary isn't configured.
    return { url: `${dataUrl}#exp=${Math.floor(expiresAt.getTime() / 1000)}&t=${token}`, expiresAt: expiresAt.toISOString(), fileId: decoded };
  }
}

function guessResourceType(publicId: string): 'raw' | 'image' {
  return /\.(png|jpe?g|gif|webp|heic)$/i.test(publicId) || publicId.includes('/receipt/') ? 'image' : 'raw';
}
