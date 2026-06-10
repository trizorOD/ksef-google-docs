const axios = require('axios');
const forge = require('node-forge');
const config = require('./config');

const BASE_URL = config.ksef.baseUrl;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Global rate-limiter — 5s gap between ALL KSeF API calls = max 12 req/min (limit is 16)
const KSEF_GAP_MS = 5000;
let _lastKSeFMs = 0;

async function throttleKSeF() {
  const gap = Date.now() - _lastKSeFMs;
  if (_lastKSeFMs > 0 && gap < KSEF_GAP_MS) await sleep(KSEF_GAP_MS - gap);
  _lastKSeFMs = Date.now();
}

// Retry wrapper — handles 429 by waiting the time KSeF specifies
async function withRetry(fn, retries = 3, delayMs = 1000) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;

      if (err.response?.status === 429) {
        const details = [].concat(err.response.data?.status?.details || []).join(' ');
        const match = details.match(/(\d+)\s+sekund/);
        const waitSec = match ? parseInt(match[1]) + 15 : 75;
        console.log(`  Rate limit 429 — waiting ${waitSec}s...`);
        await sleep(waitSec * 1000);
        _lastKSeFMs = Date.now(); // reset throttle after long wait
      } else {
        attempt++;
        const wait = delayMs * Math.pow(2, attempt - 1);
        console.log(`  Retry ${attempt}/${retries} after ${wait}ms — ${err.message}`);
        await sleep(wait);
      }
    }
  }
}

// Fetch MF's RSA public key for KsefTokenEncryption
async function fetchEncryptionPublicKey() {
  await throttleKSeF();
  const res = await axios.get(`${BASE_URL}/security/public-key-certificates`);
  _lastKSeFMs = Date.now();
  const certs = res.data;
  const entry = certs.find((c) => Array.isArray(c.usage)
    ? c.usage.includes('KsefTokenEncryption')
    : c.usage === 'KsefTokenEncryption'
  );
  if (!entry) throw new Error('KsefTokenEncryption certificate not found');
  const derBytes = forge.util.decode64(entry.certificate);
  const asn1 = forge.asn1.fromDer(derBytes);
  const cert = forge.pki.certificateFromAsn1(asn1);
  return forge.pki.publicKeyToPem(cert.publicKey);
}

// Encrypt: RSA-OAEP with SHA-256, output base64
function encryptToken(publicKeyPem, plaintext) {
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  const encrypted = publicKey.encrypt(plaintext, 'RSA-OAEP', {
    md: forge.md.sha256.create(),
    mgf1: { md: forge.md.sha256.create() },
  });
  return forge.util.encode64(encrypted);
}

const CONTEXT_IDENTIFIER = { type: 'nip', value: config.ksef.nip };

// Step 1: get challenge
async function getChallenge() {
  await throttleKSeF();
  const res = await axios.post(`${BASE_URL}/auth/challenge`, {
    contextIdentifier: CONTEXT_IDENTIFIER,
  });
  _lastKSeFMs = Date.now();
  return res.data;
}

// Step 2: send encrypted token
async function sendKsefToken(challenge, encryptedToken) {
  await throttleKSeF();
  const res = await axios.post(`${BASE_URL}/auth/ksef-token`, {
    challenge,
    contextIdentifier: CONTEXT_IDENTIFIER,
    encryptedToken,
  });
  _lastKSeFMs = Date.now();
  return res.data;
}

// Step 3: poll auth status (requires authToken as Bearer)
async function pollAuthStatus(referenceNumber, authToken, maxWaitMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await throttleKSeF();
    const res = await axios.get(`${BASE_URL}/auth/${referenceNumber}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    _lastKSeFMs = Date.now();
    const data = res.data;
    const code = data.status?.code ?? data.processingCode ?? data.status;
    if (code === 200) return data;
    if (typeof code === 'number' && code >= 400) throw new Error(`Auth failed: status ${code}`);
    // throttleKSeF() in next iteration handles the 5s wait
  }
  throw new Error('Auth polling timeout');
}

// Step 4: redeem final access+refresh tokens
async function redeemToken(referenceNumber, authToken) {
  await throttleKSeF();
  const res = await axios.post(
    `${BASE_URL}/auth/token/redeem`,
    { referenceNumber },
    { headers: { Authorization: `Bearer ${authToken}` } }
  );
  _lastKSeFMs = Date.now();
  return res.data;
}

// Full KSeF Token auth flow — returns { accessToken, refreshToken, expiresAt }
async function authenticate() {
  console.log('KSeF: authenticating...');

  const publicKeyPem = await withRetry(fetchEncryptionPublicKey);
  const { challenge, timestampMs } = await withRetry(getChallenge);

  const plaintext = `${config.ksef.token}|${timestampMs}`;
  const encryptedToken = encryptToken(publicKeyPem, plaintext);

  const tokenRes = await withRetry(() => sendKsefToken(challenge, encryptedToken));
  const { referenceNumber, authenticationToken } = tokenRes;
  const authToken = authenticationToken.token;

  await pollAuthStatus(referenceNumber, authToken);

  const redeemed = await withRetry(() => redeemToken(referenceNumber, authToken));
  const accessToken = redeemed.accessToken.token;
  const refreshToken = redeemed.refreshToken.token;
  const expiresAt = new Date(redeemed.accessToken.validUntil).getTime();

  console.log('KSeF: authenticated, token valid until', new Date(expiresAt).toISOString());
  return { accessToken, refreshToken, expiresAt };
}

// Refresh access token using refresh token
async function refreshAccessToken(refreshToken) {
  console.log('KSeF: refreshing access token...');
  await throttleKSeF();
  const res = await axios.post(`${BASE_URL}/auth/token/refresh`, { refreshToken });
  _lastKSeFMs = Date.now();
  const data = res.data;
  return {
    accessToken: data.accessToken.token,
    refreshToken: data.refreshToken?.token || refreshToken,
    expiresAt: new Date(data.accessToken.validUntil).getTime(),
  };
}

// Build axios instance with auto-refresh logic
function buildApiClient(session) {
  const client = axios.create({ baseURL: BASE_URL });

  client.interceptors.request.use(async (reqConfig) => {
    if (session.expiresAt - Date.now() < 60_000) {
      try {
        const renewed = await refreshAccessToken(session.refreshToken);
        Object.assign(session, renewed);
      } catch {
        const renewed = await authenticate();
        Object.assign(session, renewed);
      }
    }
    reqConfig.headers['Authorization'] = `Bearer ${session.accessToken}`;
    return reqConfig;
  });

  return client;
}

// Split date range into <=3-month chunks (API limit)
function splitDateRange(fromDate, toDate) {
  const chunks = [];
  const parseUTC = (s) => new Date(s.includes('Z') || s.includes('+') ? s : s + 'Z');
  let start = parseUTC(fromDate);
  const end = parseUTC(toDate);

  while (start < end) {
    const chunkEnd = new Date(start);
    chunkEnd.setUTCMonth(chunkEnd.getUTCMonth() + 3);
    const actualEnd = chunkEnd < end ? chunkEnd : end;
    const fmt = (d) => d.toISOString().replace('Z', '').slice(0, 19);
    chunks.push({ from: fmt(start), to: fmt(actualEnd) });
    start = chunkEnd;
  }
  return chunks;
}

// Authenticate and return a ready API client (no extra sleep — throttleKSeF handles rate limiting)
async function createSession() {
  const session = await authenticate();
  const client = buildApiClient(session);
  return client;
}

// Async generator — yields one page of invoice metadata at a time
async function* invoiceMetadataPages(client, subjectType, fromDate, toDate) {
  const chunks = splitDateRange(fromDate, toDate);
  console.log(`KSeF: fetching ${subjectType} from ${fromDate} to ${toDate} (${chunks.length} chunk(s))`);

  for (const chunk of chunks) {
    let pageOffset = 0;
    const pageSize = 20;
    let hasMore = true;
    const seenNums = new Set();

    while (hasMore) {
      await throttleKSeF();

      const body = {
        subjectType,
        dateRange: { dateType: 'Invoicing', from: chunk.from, to: chunk.to },
        size: pageSize,
        from: pageOffset,
      };

      const res = await withRetry(() => client.post('/invoices/query/metadata', body));
      _lastKSeFMs = Date.now();
      const data = res.data;
      const page = data.invoices || [];

      if (pageOffset === 0) {
        console.log(`  [PAGINATION] keys: ${Object.keys(data).join(', ')}`);
        console.log(`  [PAGINATION] hasMore=${data.hasMore}, isTruncated=${data.isTruncated}`);
        if (page.length > 0) console.log(`  [SAMPLE] first invoice: ${JSON.stringify(page[0])}`);
      }
      const sellers = page.map(inv => `${inv.issueDate} | ${(inv.seller?.name || inv.buyer?.name || '?').slice(0, 40)}`).join('\n    ');
      console.log(`KSeF: ${subjectType} offset=${pageOffset} got ${page.length}, hasMore=${data.hasMore}\n    ${sellers}`);

      if (page.length === 0) break;

      // Detect API cycling — stop if all items on this page were already seen
      const newItems = page.filter(inv => !seenNums.has(inv.ksefNumber));
      if (newItems.length === 0) {
        console.log(`KSeF: ${subjectType} — duplicate page detected at offset=${pageOffset}, stopping`);
        break;
      }
      newItems.forEach(inv => seenNums.add(inv.ksefNumber));

      yield newItems;

      pageOffset += page.length;
      hasMore = data.hasMore === true;
    }
  }
}

// Download invoice XML by KSeF number
async function downloadInvoiceXml(client, ksefNumber) {
  await throttleKSeF();
  const res = await withRetry(() =>
    client.get(`/invoices/ksef/${ksefNumber}`, { responseType: 'text' })
  );
  _lastKSeFMs = Date.now();
  return res.data;
}

// Legacy: authenticate and fetch both Subject1 + Subject2 at once
async function syncInvoices(fromDate, toDate, onProgress) {
  const session = await authenticate();
  const client = buildApiClient(session);

  const outgoing = await fetchAllInvoiceMetadata(client, 'Subject1', fromDate, toDate, (p) => {
    if (onProgress) onProgress({ type: 'outgoing', ...p });
  });
  const incoming = await fetchAllInvoiceMetadata(client, 'Subject2', fromDate, toDate, (p) => {
    if (onProgress) onProgress({ type: 'incoming', ...p });
  });

  return { outgoing, incoming, client };
}

async function fetchAllInvoiceMetadata(client, subjectType, fromDate, toDate, onProgress) {
  const allInvoices = [];
  for await (const page of invoiceMetadataPages(client, subjectType, fromDate, toDate)) {
    allInvoices.push(...page);
    if (onProgress) onProgress({ fetched: allInvoices.length, total: allInvoices.length });
  }
  return allInvoices;
}

module.exports = { syncInvoices, downloadInvoiceXml, createSession, invoiceMetadataPages };
