// object.store.write — upload an object to S3 / GCS / Azure Blob.
//
// Accepts `content` as either a utf-8 string (default — the common
// case after csv.stringify) or base64 (for binary, e.g. excel.build).
//
// Inputs:
//   config:      name of a stored object.store configuration
//   key:         destination key
//   content:     bytes to upload
//   encoding:    utf8 (default) | base64
//   contentType: optional MIME type stamped on the object metadata
//   bucket:      optional per-call override

import { getClient, inputToBuffer } from "../object-store/util.js";

export default {
  name: "object.store.write",
  category: "enterprise",
  description:
    "Upload an object to S3 / GCS / Azure Blob via a stored object.store " +
    "config. Pass `content` as a string and set encoding=base64 for binary " +
    "payloads (xlsx, pdf, images). The optional `contentType` is stamped on " +
    "the object metadata so downstream consumers (browsers, presigned URLs) " +
    "see the right MIME.",
  configRefs: [
    { name: "config", type: "object.store", required: true,
      description: "Name of the stored object.store configuration." },
  ],
  inputSchema: {
    type: "object",
    required: ["config", "key", "content"],
    properties: {
      config:  { type: "string", minLength: 1, title: "Object-store config" },
      key:     { type: "string", minLength: 1, title: "Destination key" },
      content: {
        type: "string", title: "Content",
        format: "textarea",
        description:
          "Bytes to upload. Set encoding=base64 for binary content " +
          "(use ${var} when the content was produced by another node).",
      },
      encoding: {
        type: "string", enum: ["utf8", "utf-8", "base64"], default: "utf8",
        title: "Input encoding",
      },
      contentType: {
        type: "string", title: "Content-Type",
        description:
          "Optional MIME type, e.g. text/csv, application/json, " +
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet (xlsx).",
      },
      bucket: { type: "string", title: "Bucket / container override" },
    },
  },
  primaryOutput: "key",
  outputSchema: {
    type: "object",
    required: ["key", "size"],
    properties: {
      key:    { type: "string" },
      bucket: { type: "string" },
      size:   { type: "integer" },
      etag:   { type: ["string", "null"] },
    },
  },
  async execute({ config, key, content, encoding = "utf8", contentType, bucket }, ctx) {
    const { client, bucket: resolvedBucket } = await getClient(ctx, config, bucket);
    const buf = inputToBuffer(content, encoding);
    const r   = await client.put(resolvedBucket, key, buf, contentType);
    return { key, bucket: resolvedBucket, size: r.size, etag: r.etag };
  },
};
