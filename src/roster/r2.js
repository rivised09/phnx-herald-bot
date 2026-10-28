/**
 * Cloudflare R2, used as a plain object store.
 *
 * R2 speaks the S3 API, so the SDK is the shortest path to it - the endpoint,
 * the region `auto` and path-style addressing are the only R2-specific parts.
 * The client is required lazily: exporting to a directory is a supported mode
 * (it is how the files are checked before anything is uploaded), and that mode
 * must not need the dependency or the credentials.
 *
 * Credentials come from the environment, never from a file in the repository:
 *
 *   R2_ACCOUNT_ID         account id, the one in the R2 dashboard URL
 *   R2_ACCESS_KEY_ID      from an "Object Read & Write" API token
 *   R2_SECRET_ACCESS_KEY  its secret, shown once
 *   R2_BUCKET             bucket name
 *   R2_PREFIX             key prefix, "roster" by default
 */
const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

function config() {
  const env = process.env;
  const values = {
    accountId: String(env.R2_ACCOUNT_ID || '').trim(),
    accessKeyId: String(env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY || '').trim(),
    bucket: String(env.R2_BUCKET || '').trim(),
    prefix: String(env.R2_PREFIX || 'roster').replace(/^\/+|\/+$/g, ''),
  };
  const missing = REQUIRED.filter((name) => !String(env[name] || '').trim());
  return { ...values, missing };
}

function configured() {
  return config().missing.length === 0;
}

/** What to tell whoever is running the export when it is not configured. */
function describeMissing() {
  return config().missing.join(', ');
}

let client = null;

function s3() {
  const cfg = config();
  if (cfg.missing.length) {
    throw new Error(`R2 is not configured: ${cfg.missing.join(', ')} is missing.`);
  }
  if (client) return { cfg, client };
  const { S3Client } = require('@aws-sdk/client-s3');
  client = new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return { cfg, client };
}

function objectKey(key) {
  const { prefix } = config();
  return prefix ? `${prefix}/${key}` : key;
}

/**
 * Uploads one JSON document.
 *
 * The cache header is per file rather than per bucket because the two change at
 * different rates: `index.json` moves whenever a snapshot lands, while a
 * historical snapshot never changes again and only needs to survive a deploy.
 */
async function putJson(key, value, { cacheControl = 'public, max-age=600' } = {}) {
  const { cfg, client: s3Client } = s3();
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const body = Buffer.from(JSON.stringify(value));
  await s3Client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: objectKey(key),
      Body: body,
      ContentType: 'application/json; charset=utf-8',
      CacheControl: cacheControl,
    }),
  );
  return body.length;
}

/**
 * Every key under a prefix, relative to `R2_PREFIX`.
 *
 * `listKeys('players/')` returns `players/25732950.json` and so on. The index
 * uses it to count what is actually published rather than trusting a number it
 * wrote last time, so a scrape that adds players cannot drift from the files.
 */
async function listKeys(prefix = '') {
  const { cfg, client: s3Client } = s3();
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const full = objectKey(prefix);
  const keys = [];
  let token;
  do {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucket,
        Prefix: full,
        ContinuationToken: token,
      }),
    );
    for (const item of result.Contents || []) keys.push(item.Key);
    token = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (token);

  const root = config().prefix ? `${config().prefix}/` : '';
  return keys.map((key) => (root && key.startsWith(root) ? key.slice(root.length) : key));
}

/** Reads one JSON document back. Used by the export's own verification pass. */
async function getJson(key) {
  const { cfg, client: s3Client } = s3();
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const result = await s3Client.send(
    new GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey(key) }),
  );
  return JSON.parse(await result.Body.transformToString('utf-8'));
}

module.exports = { configured, describeMissing, putJson, getJson, listKeys, objectKey, config };
