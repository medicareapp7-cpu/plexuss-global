/**
 * Quick Zoho API Diagnostic — checks how many invoices exist and page_context
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Load .env
try {
  const envLines = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n');
  for (const line of envLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (_) {}

const ORG_ID = process.env.ZOHO_ORG_ID || "815849495";
const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const FALLBACK_REFRESH = "1000.5b1ed0025d3641c7f22860229301c001.f649ff65d36b20da5664ec563cd41a16";
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || FALLBACK_REFRESH;

async function getToken() {
  const tokens = JSON.parse(fs.readFileSync(path.join(__dirname, 'tokens.json'), 'utf8'));
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }
  // Refresh
  const url = `https://accounts.zoho.com/oauth/v2/token?refresh_token=${REFRESH_TOKEN}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
  fs.writeFileSync(path.join(__dirname, 'tokens.json'), JSON.stringify(tokens, null, 2));
  console.log('✅ Token refreshed OK\n');
  return data.access_token;
}

async function diagnose() {
  console.log('=================================================');
  console.log(`🔍 Zoho Books API Diagnostic`);
  console.log(`   Org ID: ${ORG_ID}`);
  console.log('=================================================\n');

  const token = await getToken();

  // Test 1 — Default (no filter_by)
  console.log('📋 TEST 1: Default /invoices (no filter_by, per_page=200, page=1)');
  const r1 = await fetch(`https://www.zohoapis.com/books/v3/invoices?page=1&per_page=200&sort_column=date&sort_order=D&organization_id=${ORG_ID}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  });
  const d1 = await r1.json();
  console.log(`   HTTP Status : ${r1.status}`);
  console.log(`   Invoices returned : ${d1.invoices?.length ?? 'N/A'}`);
  console.log(`   has_more_page : ${d1.page_context?.has_more_page}`);
  console.log(`   total_invoices : ${d1.page_context?.total ?? 'N/A'}`);
  console.log(`   API code : ${d1.code ?? 'OK'}\n`);

  // Test 2 — With filter_by=Status.All
  console.log('📋 TEST 2: /invoices?filter_by=Status.All (per_page=200, page=1)');
  const r2 = await fetch(`https://www.zohoapis.com/books/v3/invoices?filter_by=Status.All&page=1&per_page=200&sort_column=date&sort_order=D&organization_id=${ORG_ID}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` }
  });
  const d2 = await r2.json();
  console.log(`   HTTP Status : ${r2.status}`);
  console.log(`   Invoices returned : ${d2.invoices?.length ?? 'N/A'}`);
  console.log(`   has_more_page : ${d2.page_context?.has_more_page}`);
  console.log(`   total_invoices : ${d2.page_context?.total ?? 'N/A'}`);
  console.log(`   API code : ${d2.code ?? 'OK'}\n`);

  // Test 3 — Count all pages with Status.All
  if (d2.page_context?.has_more_page) {
    console.log('📋 TEST 3: Counting ALL pages with filter_by=Status.All...');
    let totalInv = d2.invoices?.length || 0;
    let pg = 2;
    while (true) {
      const r = await fetch(`https://www.zohoapis.com/books/v3/invoices?filter_by=Status.All&page=${pg}&per_page=200&sort_column=date&sort_order=D&organization_id=${ORG_ID}`, {
        headers: { Authorization: `Zoho-oauthtoken ${token}` }
      });
      const d = await r.json();
      if (!d.invoices || d.invoices.length === 0) break;
      totalInv += d.invoices.length;
      process.stdout.write(`   Page ${pg}: ${totalInv} total so far...\r`);
      if (!d.page_context?.has_more_page) break;
      pg++;
      await new Promise(r => setTimeout(r, 100));
    }
    console.log(`\n   ✅ TOTAL invoices (all pages): ${totalInv}\n`);
  }

  // Test 4 — Check current latest_report.json
  console.log('📋 TEST 4: Local latest_report.json analysis');
  try {
    const jsonPath = path.join(__dirname, 'latest_report.json');
    const stat = fs.statSync(jsonPath);
    const records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const expired = records.filter(r => r.status === 'EXPIRED');
    const expiring = records.filter(r => r.status === 'EXPIRING_SOON');
    const active = records.filter(r => r.status === 'ACTIVE');
    const today = new Date(); today.setHours(0,0,0,0);
    // Recount with fresh date
    const actualExpired = records.filter(r => r.expire_date && new Date(r.expire_date) < today);
    console.log(`   File modified: ${stat.mtime.toISOString()}`);
    console.log(`   Total records: ${records.length}`);
    console.log(`   Stored EXPIRED: ${expired.length}`);
    console.log(`   Stored EXPIRING_SOON: ${expiring.length}`);
    console.log(`   Stored ACTIVE: ${active.length}`);
    console.log(`   Recalculated EXPIRED (today=${today.toISOString().split('T')[0]}): ${actualExpired.length}`);
    if (records.length > 0) {
      const sorted = [...records].sort((a,b) => (a.invoice_date||'').localeCompare(b.invoice_date||''));
      console.log(`   Oldest invoice date in JSON: ${sorted[0]?.invoice_date}`);
      console.log(`   Newest invoice date in JSON: ${sorted[sorted.length-1]?.invoice_date}`);
    }
  } catch (e) {
    console.log(`   ❌ Error reading latest_report.json: ${e.message}`);
  }

  // Test 5 — Check invoice cache
  console.log('\n📋 TEST 5: Local invoices_cache.json');
  try {
    const cachePath = path.join(__dirname, 'invoices_cache.json');
    if (fs.existsSync(cachePath)) {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const keys = Object.keys(cache);
      console.log(`   Cached invoices: ${keys.length}`);
    } else {
      console.log(`   No invoices_cache.json found — full sync needed`);
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}`);
  }

  console.log('\n=================================================');
  console.log('🏁 Diagnostic Complete');
  console.log('=================================================\n');
}

diagnose().catch(err => console.error('Fatal:', err.message));
