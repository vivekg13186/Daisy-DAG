// object.store.list — list object keys by prefix.
//
// Returns up to `maxKeys` entries with metadata (size, etag, lastModified).
// `truncated` indicates whether more pages exist — pagination tokens are
// not surfaced in v1; if you need more than ~1000 keys, narrow the prefix.

import { getClient } from "../object-store/util.js";

const DEFAULT_MAX_KEYS = 100;
const MAX_MAX_KEYS     = 1000;

export default {
  name: "object.store.list",
  category: "enterprise",
  description:
    "List objects in a bucket / container by prefix. Returns up to `maxKeys` " +
    "entries (default 100, cap 1000) with size + etag + lastModified. " +
    "`truncated` is true when more pages exist — narrow the prefix to get more.",
  configRefs: [
    { name: "config", type: "object.store", required: true },
  ],
  inputSchema: {
    type: "object",
    required: ["config"],
    properties: {
      config:  { type: "string", minLength: 1, title: "Object-store config" },
      prefix:  { type: "string", title: "Key prefix",
                 description: "List only keys starting with this string." },
      maxKeys: {
        type: "integer", minimum: 1, maximum: MAX_MAX_KEYS,
        default: DEFAULT_MAX_KEYS, title: "Max keys",
      },
      bucket:  { type: "string", title: "Bucket / container override" },
    },
  },
  primaryOutput: "items",
  outputSchema: {
    type: "object",
    required: ["items", "truncated"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key:          { type: "string" },
            size:         { type: "integer" },
            etag:         { type: ["string", "null"] },
            lastModified: {},
          },
        },
      },
      truncated: { type: "boolean" },
      bucket:    { type: "string" },
    },
  },
  async execute({ config, prefix, maxKeys = DEFAULT_MAX_KEYS, bucket }, ctx) {
    const { client, bucket: resolvedBucket } = await getClient(ctx, config, bucket);
    const r = await client.list(resolvedBucket, prefix || "", Math.min(maxKeys, MAX_MAX_KEYS));
    return {
      items:     r.items,
      truncated: !!r.truncated,
      bucket:    resolvedBucket,
    };
  },
};
