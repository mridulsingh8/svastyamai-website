import { isIP } from 'node:net';

const ALLOWED_TYPES = new Set([
  'Independent Doctor',
  'Clinic Owner / Admin',
  'Hospital Group',
  'PMS / EHR Partner',
  'Investor / Advisor',
]);

const FIELD_LIMITS = {
  Name: 100,
  Email: 254,
  Type: 40,
};

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_PRUNE_INTERVAL_MS = RATE_LIMIT_WINDOW_MS;
const RATE_LIMIT_MAX_BUCKETS = 1000;
const rateLimitBuckets = new Map();
let lastRateLimitPruneAt = 0;

function getHeaderValue(header) {
  return Array.isArray(header) ? header[0] : header;
}

function normalizeClientIp(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!isIP(trimmed)) {
    return null;
  }

  return trimmed;
}

function getClientIp(req) {
  // Vercel overwrites this platform-controlled header with client IP data.
  // Generic X-Forwarded-For is deliberately ignored because upstream clients
  // and proxies can supply or extend it with an untrusted chain.
  const vercelForwardedFor = getHeaderValue(req.headers?.['x-vercel-forwarded-for']);
  const clientIp = vercelForwardedFor
    ?.split(',')
    .map((ip) => normalizeClientIp(ip))
    .find(Boolean);

  return clientIp
    || normalizeClientIp(req.socket?.remoteAddress)
    || 'unknown';
}

function pruneExpiredRateLimitBuckets(now) {
  if (now - lastRateLimitPruneAt < RATE_LIMIT_PRUNE_INTERVAL_MS) {
    return;
  }

  lastRateLimitPruneAt = now;
  for (const [key, bucket] of rateLimitBuckets.entries()) {
    if (now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) {
      rateLimitBuckets.delete(key);
    } else {
      // Insertion-ordered Map ensures older buckets are always at the start.
      // If this one is not expired, none of the subsequent ones are.
      break;
    }
  }
}

function isRateLimited(ip) {
  const now = Date.now();
  pruneExpiredRateLimitBuckets(now);

  const bucket = rateLimitBuckets.get(ip);
  if (!bucket) {
    if (rateLimitBuckets.size >= RATE_LIMIT_MAX_BUCKETS) {
      // Evict any expired buckets first to reclaim space
      for (const [key, b] of rateLimitBuckets.entries()) {
        if (now - b.startedAt >= RATE_LIMIT_WINDOW_MS) {
          rateLimitBuckets.delete(key);
        } else {
          break;
        }
      }
      
      // If the map is still full (all stored buckets are currently active),
      // reject the new client to prevent rate-limit bypass and protect the backend database.
      if (rateLimitBuckets.size >= RATE_LIMIT_MAX_BUCKETS) {
        return true;
      }
    }

    rateLimitBuckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }

  if (now - bucket.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitBuckets.delete(ip);
    rateLimitBuckets.set(ip, { startedAt: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX_REQUESTS;
}

function sanitizeSpreadsheetValue(value) {
  const trimmed = value.trim();
  return /^[=+\-@]/.test(trimmed) ? `'${trimmed}` : trimmed;
}

function validateField(body, field) {
  if (typeof body?.[field] !== 'string') {
    return null;
  }

  const value = body[field].trim();
  if (!value || value.length > FIELD_LIMITS[field]) {
    return null;
  }

  return value;
}

function validateSubmission(body) {
  const name = validateField(body, 'Name');
  const email = validateField(body, 'Email');
  const type = validateField(body, 'Type');

  if (!name || !email || !type) {
    return null;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  if (!ALLOWED_TYPES.has(type)) {
    return null;
  }

  return {
    Name: sanitizeSpreadsheetValue(name),
    Email: sanitizeSpreadsheetValue(email),
    Type: sanitizeSpreadsheetValue(type),
  };
}

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Too Many Requests' });
  }

  const payload = validateSubmission(req.body);
  if (!payload) {
    return res.status(400).json({ error: 'Invalid waitlist submission' });
  }

  // Get the Google Script URL securely from Vercel's Environment Variables or local .env
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;

  if (!scriptUrl) {
    return res.status(500).json({ error: 'Server misconfiguration: missing URL' });
  }

  try {
    // We forward the request as a typical URL Encoded form POST
    // which is what Google Apps script handles best.
    const response = await fetch(scriptUrl, {
      method: 'POST',
      body: new URLSearchParams(payload),
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'Failed to submit' });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error submitting to Google Sheet:', error);
    return res.status(500).json({ error: 'Failed to submit' });
  }
}
