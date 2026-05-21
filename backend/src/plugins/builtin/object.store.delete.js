// object.store.delete — remove an object.
//
// One key per call. Always succeeds (idempotent) — deleting a non-existent
// key is not an error on any of the three backends, so workflows don't
// need defensive `executeIf` checks.

import { getClient } from "../object-store/util.js";

export default {
  name: "object.store.delete",
  category: "enterprise",
  description:
    "Delete a single object by key. Idempotent — deleting a non-existent " +
    "key succeeds silently on all three providers, so no executeIf guard " +
    "is needed for cleanup nodes.",
  configRefs: [
    { name: "config", type: "object.store", required: true },
  ],
  inputSchema: {
    type: "object",
    required: ["config", "key"],
    properties: {
      config: { type: "string", minLength: 1, title: "Object-store config" },
      key:    { type: "string", minLength: 1, title: "Object key" },
      bucket: { type: "string", title: "Bucket / container override" },
    },
  },
  primaryOutput: "deleted",
  outputSchema: {
    type: "object",
    required: ["deleted", "key"],
    properties: {
      deleted: { type: "boolean" },
      key:     { type: "string" },
      bucket:  { type: "string" },
    },
  },
  async execute({ config, key, bucket }, ctx) {
    const { client, bucket: resolvedBucket } = await getClient(ctx, config, bucket);
    await client.del(resolvedBucket, key);
    return { deleted: true, key, bucket: resolvedBucket };
  },
};
