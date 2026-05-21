// object.store.read — fetch an object from S3 / GCS / Azure Blob.
//
// Returns the object's content as either a utf-8 string (default,
// for text/csv/json) or a base64 string (for binary — xlsx, images,
// pdfs). Pair with csv.parse / excel.parse / json transforms
// downstream.
//
// Inputs:
//   config:   name of a stored object.store configuration
//   key:      object key (path inside the bucket)
//   bucket:   optional per-call override (default = config's bucket)
//   encoding: utf8 (default) | base64

import { getClient, bufferToOutput } from "../object-store/util.js";

export default {
  name: "object.store.read",
  category: "enterprise",
  description:
    "Read an object from S3 / GCS / Azure Blob via a stored object.store " +
    "config. Returns the content as a utf-8 string (default) or base64. " +
    "Use encoding=base64 for binary content (xlsx/pdf/images) so it " +
    "survives JSON round-trips and can be handed to excel.parse, etc.",
  configRefs: [
    { name: "config", type: "object.store", required: true,
      description: "Name of the stored object.store configuration." },
  ],
  inputSchema: {
    type: "object",
    required: ["config", "key"],
    properties: {
      config: {
        type: "string", minLength: 1, title: "Object-store config",
        description: "Name of a stored object.store configuration (Home → Configurations).",
      },
      key: {
        type: "string", minLength: 1, title: "Object key",
        description: "Path inside the bucket / container, e.g. exports/2026/q1.csv.",
      },
      bucket: {
        type: "string", title: "Bucket / container override",
        description: "Optional — leave blank to use the config's default bucket.",
      },
      encoding: {
        type: "string", enum: ["utf8", "utf-8", "base64", "binary"], default: "utf8",
        title: "Output encoding",
        description: "utf8 for text, base64 (or binary) for binary content.",
      },
    },
  },
  primaryOutput: "content",
  outputSchema: {
    type: "object",
    required: ["content", "key", "size"],
    properties: {
      content:     { type: "string" },
      key:         { type: "string" },
      bucket:      { type: "string" },
      size:        { type: "integer" },
      contentType: { type: ["string", "null"] },
      etag:        { type: ["string", "null"] },
      encoding:    { type: "string" },
    },
  },
  async execute({ config, key, bucket, encoding = "utf8" }, ctx) {
    const { client, bucket: resolvedBucket } = await getClient(ctx, config, bucket);
    const r = await client.get(resolvedBucket, key);
    return {
      content:     bufferToOutput(r.body, encoding),
      key,
      bucket:      resolvedBucket,
      size:        r.size,
      contentType: r.contentType,
      etag:        r.etag,
      encoding,
    };
  },
};
