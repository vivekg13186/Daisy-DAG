// object.store.signed_url — generate a time-bound presigned URL.
//
// Two operations:
//   • get (default) — anyone with the URL can download the object until
//                     it expires. Useful for emailing download links,
//                     handing artifacts to external systems.
//   • put           — anyone with the URL can upload an object at that
//                     key until it expires. Useful for user-uploaded
//                     artifacts where the backend doesn't want to proxy
//                     the bytes.
//
// Azure caveat: SAS-authenticated configs can't generate per-blob SAS
// URLs (no shared key to sign with) — the plugin throws a clear error.
// Switch the config to azureKey-based auth if you need this.

import { getClient } from "../object-store/util.js";

const DEFAULT_EXPIRES_SEC = 600;          // 10 minutes
const MAX_EXPIRES_SEC     = 7 * 24 * 3600; // 7 days — the S3 v4 hard ceiling

export default {
  name: "object.store.signed_url",
  category: "enterprise",
  description:
    "Generate a time-bound presigned URL for an object. Use op=get for " +
    "download links, op=put for upload links. Default expiry 10 min; " +
    "max 7 days (S3's signing limit). Azure SAS-only configs cannot sign " +
    "per-blob URLs — use azureKey instead.",
  configRefs: [
    { name: "config", type: "object.store", required: true },
  ],
  inputSchema: {
    type: "object",
    required: ["config", "key"],
    properties: {
      config: { type: "string", minLength: 1, title: "Object-store config" },
      key:    { type: "string", minLength: 1, title: "Object key" },
      op: {
        type: "string", enum: ["get", "put"], default: "get",
        title: "Operation",
        description: "get → presigned download. put → presigned upload.",
      },
      expiresIn: {
        type: "integer", minimum: 1, maximum: MAX_EXPIRES_SEC,
        default: DEFAULT_EXPIRES_SEC,
        title: "Expires in (seconds)",
      },
      bucket: { type: "string", title: "Bucket / container override" },
    },
  },
  primaryOutput: "url",
  outputSchema: {
    type: "object",
    required: ["url", "expiresAt"],
    properties: {
      url:       { type: "string" },
      key:       { type: "string" },
      bucket:    { type: "string" },
      op:        { type: "string" },
      expiresAt: { type: "string", format: "date-time" },
    },
  },
  async execute({ config, key, op = "get", expiresIn = DEFAULT_EXPIRES_SEC, bucket }, ctx) {
    const { client, bucket: resolvedBucket } = await getClient(ctx, config, bucket);
    const expiresInSec = Math.min(Math.max(1, expiresIn | 0), MAX_EXPIRES_SEC);
    const { url } = await client.signedUrl(resolvedBucket, key, op, expiresInSec);
    return {
      url,
      key,
      bucket:    resolvedBucket,
      op,
      expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(),
    };
  },
};
