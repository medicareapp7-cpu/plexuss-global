/**
 * Standalone Web Dashboard Server for Expired Products & Warranty Reports
 * Built with pure Node.js (Zero external dependencies required!)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { extractAllExpiredProducts, toCSV } = require('./generate_report');

// Load environment variables
function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of envLines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim();
          process.env[key] = val;
        }
      }
    }
  } catch (_) {}
}
loadEnv();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKENS_PATH = path.join(__dirname, 'tokens.json');

let cachedReport = null;
let lastExtractedTime = null;
let extractionPromise = null; // Promise-based lock to prevent duplicate parallel extractions

// Try to load cached report on startup
try {
  const jsonPath = path.join(__dirname, 'latest_report.json');
  if (fs.existsSync(jsonPath)) {
    cachedReport = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    lastExtractedTime = fs.statSync(jsonPath).mtime;
  }
} catch (_) {}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

function getRedirectUri(req) {
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http');

  // When running locally, use localhost redirect URI
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    return `http://${host}/auth/callback`;
  }

  if (process.env.APP_URL) {
    return `${process.env.APP_URL.replace(/\/$/, '')}/auth/callback`;
  }

  return `${proto}://${host}/auth/callback`;
}

const os = require('os');

async function exchangeAuthCode(code, redirectUri = '') {
  loadEnv();
  const clientId = process.env.ZOHO_CLIENT_ID || "1000.60T24PKMTMV3TC2HOEMXDB3PNJZX9F";
  const clientSecret = process.env.ZOHO_CLIENT_SECRET || "ec379df0a288f63c59546f33cb821676e78407c5f3";
  
  let url = `https://accounts.zoho.com/oauth/v2/token?code=${encodeURIComponent(code.trim())}&client_id=${clientId}&client_secret=${clientSecret}&grant_type=authorization_code`;
  if (redirectUri) {
    url += `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (data.access_token) {
    const tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || process.env.ZOHO_REFRESH_TOKEN || (fs.existsSync(TOKENS_PATH) ? JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')).refresh_token : ''),
      api_domain: data.api_domain || "https://www.zohoapis.com",
      token_type: "Bearer",
      expires_in: data.expires_in || 3600,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000
    };
    try {
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
    } catch (_) {
      try {
        fs.writeFileSync(path.join(os.tmpdir(), 'tokens.json'), JSON.stringify(tokens, null, 2), 'utf8');
      } catch (_) {}
    }
    return { success: true, tokens };
  }
  return { success: false, error: data };
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // 1. OAuth Initiate / Login Link
  if (pathname === '/auth/login') {
    loadEnv();
    const clientId = process.env.ZOHO_CLIENT_ID || "1000.60T24PKMTMV3TC2HOEMXDB3PNJZX9F";
    const redirectUri = getRedirectUri(req);
    const scope = 'ZohoBooks.fullaccess.all';
    const authUrl = `https://accounts.zoho.com/oauth/v2/auth?scope=${scope}&client_id=${clientId}&response_type=code&access_type=offline&prompt=consent&redirect_uri=${encodeURIComponent(redirectUri)}`;
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }

  // 2. OAuth Callback
  if (pathname === '/auth/callback' || pathname === '/oauth/callback' || pathname === '/oauthCallback' || (pathname === '/' && parsedUrl.searchParams.has('code'))) {
    const code = parsedUrl.searchParams.get('code');
    if (code) {
      const detectedUri = getRedirectUri(req);
      let result = await exchangeAuthCode(code, detectedUri);

      if (!result.success) {
        result = await exchangeAuthCode(code, 'https://plexuss-global.vercel.app/auth/callback');
      }
      if (!result.success) {
        result = await exchangeAuthCode(code, 'https://plexuss-39jpszq5r-plexuss.vercel.app/auth/callback');
      }
      if (!result.success) {
        result = await exchangeAuthCode(code, `http://localhost:${PORT}`);
      }
      if (!result.success) {
        result = await exchangeAuthCode(code, '');
      }

      if (result.success) {
        res.writeHead(302, { Location: '/?auth_success=true' });
        return res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(`<h2>Zoho Authorization Error</h2><pre>${JSON.stringify(result.error, null, 2)}</pre><br><a href="/">Back to Dashboard</a>`);
      }
    }
  }

  // 3. API: Save Code manually (from UI input)
  if (pathname === '/api/save-code' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const json = JSON.parse(body || '{}');
        const code = json.code;
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Code is required' }));
        }
        const result = await exchangeAuthCode(code);
        if (result.success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: true, message: 'Connected successfully!' }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: result.error }));
        }
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 4. API: Get Report Data
  if (pathname === '/api/report') {
    const refresh = parsedUrl.searchParams.get('refresh') === 'true';
    const warrantyMonths = parseInt(parsedUrl.searchParams.get('warranty_months') || '12', 10);

    if (refresh || !cachedReport) {
      // If an extraction is already in progress, wait for it (don't spawn a new one)
      if (extractionPromise) {
        try { await extractionPromise; } catch (_) {}
      } else {
        // Start a new extraction and store the promise so concurrent requests share it
        extractionPromise = (async () => {
          const records = await extractAllExpiredProducts({
            onlyExpired: false,
            warrantyMonths: warrantyMonths
          });
          cachedReport = records;
          lastExtractedTime = new Date();
          try {
            fs.writeFileSync(path.join(__dirname, 'latest_report.json'), JSON.stringify(records, null, 2), 'utf8');
          } catch (_) {
            try {
              fs.writeFileSync(path.join(os.tmpdir(), 'latest_report.json'), JSON.stringify(records, null, 2), 'utf8');
            } catch (_) {}
          }
        })();
        try {
          await extractionPromise;
        } catch (err) {
          extractionPromise = null;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        } finally {
          extractionPromise = null;
        }
      }
    }

    // Always return ALL records — client-side JS handles status filtering (Expired/Active/Expiring Soon)
    let filtered = cachedReport || [];

    const search = (parsedUrl.searchParams.get('search') || '').toLowerCase().trim();
    if (search) {
      filtered = filtered.filter(r => 
        (r.item_name || '').toLowerCase().includes(search) ||
        (r.sku || '').toLowerCase().includes(search) ||
        (r.serial_number || '').toLowerCase().includes(search) ||
        (r.invoice_number || '').toLowerCase().includes(search) ||
        (r.customer_name || '').toLowerCase().includes(search)
      );
    }

    const expiredList = (cachedReport || []).filter(r => r.status === 'EXPIRED');
    const currencyTotals = {};
    for (const r of expiredList) {
      const c = r.currency || 'USD';
      currencyTotals[c] = (currencyTotals[c] || 0) + Number(r.sub_total || 0);
    }
    const formattedValueStr = Object.entries(currencyTotals)
      .map(([c, val]) => `${c} ${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
      .join(' + ') || 'USD 0.00';

    const stats = {
      total_items: (cachedReport || []).length,
      expired_items: expiredList.length,
      expiring_soon_items: (cachedReport || []).filter(r => r.status === 'EXPIRING_SOON').length,
      active_items: (cachedReport || []).filter(r => r.status === 'ACTIVE').length,
      total_expired_value: expiredList.reduce((sum, r) => sum + Number(r.sub_total || 0), 0).toFixed(2),
      total_expired_by_currency: currencyTotals,
      total_expired_value_formatted: formattedValueStr,
      last_updated: lastExtractedTime ? lastExtractedTime.toISOString() : null,
      is_extracting: extractionPromise !== null
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      stats,
      records: filtered,
      count: filtered.length
    }));
  }

  // 5. API: Download CSV
  if (pathname === '/api/download-csv') {
    const onlyExpired = parsedUrl.searchParams.get('only_expired') !== 'false';
    let data = cachedReport || [];
    if (onlyExpired) {
      data = data.filter(r => r.status === 'EXPIRED');
    }
    const csvString = toCSV(data);
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `expired_products_report_${dateStr}.csv`;

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    return res.end(csvString);
  }

  // 6. Static Files
  let reqFile = pathname === '/' ? 'index.html' : pathname;
  let fullPath = path.join(PUBLIC_DIR, reqFile);

  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    fullPath = path.join(PUBLIC_DIR, 'index.html');
  }

  if (fs.existsSync(fullPath)) {
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' });
    fs.createReadStream(fullPath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Dashboard Running at http://localhost:${PORT}`);
  console.log(`🔑 Direct Zoho Login: http://localhost:${PORT}/auth/login`);
  console.log(`======================================================\n`);
});
