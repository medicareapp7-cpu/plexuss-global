const fs = require('fs');
const path = require('path');

// 1. Load .env
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

const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ORG_ID = process.env.ZOHO_ORG_ID || "815849495";
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const DEFAULT_WARRANTY_MONTHS = 12; // 1 Year default

const CACHE_FILE = path.join(__dirname, 'invoices_cache.json');
let cache = {};
if (fs.existsSync(CACHE_FILE)) {
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) {}
}

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60000) return cachedToken;
  const tokensPath = path.join(__dirname, 'tokens.json');
  if (fs.existsSync(tokensPath)) {
    try {
      const t = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
      if (t.access_token && t.expires_at && Date.now() < t.expires_at - 60000) {
        cachedToken = t.access_token;
        cachedTokenExpiresAt = t.expires_at;
        return cachedToken;
      }
    } catch (_) {}
  }
  const url = `https://accounts.zoho.com/oauth/v2/token?refresh_token=${REFRESH_TOKEN}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(data));
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  fs.writeFileSync(tokensPath, JSON.stringify({ access_token: cachedToken, refresh_token: REFRESH_TOKEN, expires_at: cachedTokenExpiresAt }, null, 2));
  return cachedToken;
}

async function apiGet(endpoint, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const token = await getToken();
      const sep = endpoint.includes('?') ? '&' : '?';
      const url = `https://www.zohoapis.com/books/v3${endpoint}${sep}organization_id=${ORG_ID}`;
      const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${token}` } });
      if (res.status === 401) {
        cachedToken = null;
        continue;
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
}

function detectWarrantyMonths(name, desc = '', sku = '') {
  const text = `${name} ${desc} ${sku}`.toLowerCase();
  if (text.includes('5 year') || text.includes('5y ') || text.includes('5-year') || text.includes('60m') || text.includes('60 month')) return 60;
  if (text.includes('3 year') || text.includes('3y ') || text.includes('3-year') || text.includes('36m') || text.includes('36 month')) return 36;
  if (text.includes('2 year') || text.includes('2y ') || text.includes('2-year') || text.includes('24m') || text.includes('24 month') || text.includes('24 mo')) return 24;
  if (text.includes('1 year') || text.includes('1y ') || text.includes('1-year') || text.includes('12m') || text.includes('12 month')) return 12;
  if (text.includes('6 month') || text.includes('6m')) return 6;
  return 12; // Default to 12 months (1 Year)
}

function parseZohoDate(val) {
  if (!val) return null;
  val = String(val).trim();
  if (!val || val === 'dd.MM.yyyy' || val === 'N/A' || val.toLowerCase() === 'null') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
  const m = val.match(/^(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(val);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

function calculateExpiryDate(invDate, months) {
  if (!invDate) return null;
  const d = new Date(invDate);
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + months);
  return d.toISOString().split('T')[0];
}

async function main() {
  const minExpireDate = '2024-04-01';
  const minInvoiceDate = '2023-04-01'; // To capture products that expired starting 2024-04-01
  console.log(`[Sync] Starting extraction for Plexuss Global: Invoices since ${minInvoiceDate}, Expirations since ${minExpireDate}...`);

  // Step 1: Fetch invoice list page by page until date < minInvoiceDate
  const allInvoices = [];
  let page = 1;
  const perPage = 200;
  let reachedBefore = false;

  while (!reachedBefore) {
    console.log(`[Sync] Fetching invoice list page ${page}...`);
    const data = await apiGet(`/invoices?page=${page}&per_page=${perPage}&sort_column=date&sort_order=D`);
    if (!data || !data.invoices || data.invoices.length === 0) break;

    for (const inv of data.invoices) {
      if (inv.date < minInvoiceDate) {
        reachedBefore = true;
        break;
      }
      allInvoices.push(inv);
    }
    if (reachedBefore || !data.page_context?.has_more_page) break;
    page++;
  }

  console.log(`[Sync] Found ${allInvoices.length} invoices since ${minInvoiceDate}.`);

  // Step 2: Fetch details for invoices not yet in cache
  const toFetch = allInvoices.filter(inv => !cache[inv.invoice_id] || !cache[inv.invoice_id].invoice);
  console.log(`[Sync] Invoices already cached: ${allInvoices.length - toFetch.length}, Need to fetch: ${toFetch.length}`);

  const BATCH_SIZE = 15;
  let fetchedCount = 0;

  for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
    const batch = toFetch.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (inv) => {
      try {
        const d = await apiGet(`/invoices/${inv.invoice_id}`);
        if (d && d.invoice) {
          cache[inv.invoice_id] = { invoice: d.invoice, last_modified_time: inv.last_modified_time };
        }
      } catch (err) {
        console.warn(`[Sync] Error on invoice ${inv.invoice_number}:`, err.message);
      }
    }));

    fetchedCount += batch.length;
    if (fetchedCount % 150 === 0 || fetchedCount >= toFetch.length) {
      console.log(`[Sync] Progress: ${fetchedCount}/${toFetch.length} invoices fetched (${Math.round(fetchedCount/toFetch.length*100)}%). Saving cache...`);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
    }
    await new Promise(r => setTimeout(r, 60));
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  console.log(`[Sync] All invoice details cached! Total cached: ${Object.keys(cache).length}`);

  // Step 3: Build records array
  const today = new Date('2026-09-15');
  today.setHours(0, 0, 0, 0);

  const reportRecords = [];

  for (const invSummary of allInvoices) {
    const cachedEntry = cache[invSummary.invoice_id];
    if (!cachedEntry || !cachedEntry.invoice) continue;
    const invoice = cachedEntry.invoice;

    const invNumber = invoice.invoice_number || invSummary.invoice_number || '';
    const rawInvDate = invoice.date || invSummary.date || '';
    const invDate = parseZohoDate(rawInvDate) || rawInvDate;
    const customerName = invoice.customer_name || invSummary.customer_name || '';
    const currencyCode = invoice.currency_code || 'LKR';

    for (const item of (invoice.line_items || [])) {
      const itemName = item.name || item.description || 'Unnamed Item';
      if (itemName.toUpperCase() === 'OPB' || (item.sku && item.sku.toUpperCase() === 'OPB')) continue;

      let sku = item.sku || '';
      const cfs = item.item_custom_fields || item.line_item_custom_fields || item.custom_fields || [];
      if (!sku && Array.isArray(cfs)) {
        const skuF = cfs.find(f => f.api_name === 'cf_sku' || f.api_name === 'cf_part_no');
        if (skuF) sku = skuF.value || skuF.value_formatted || '';
      }

      // Check explicit expiry in Zoho
      let explicitExpire = null;
      if (Array.isArray(cfs)) {
        const expF = cfs.find(f => f.api_name === 'cf_warranty_expired' || f.api_name === 'cf_sla_period');
        if (expF && expF.value) {
          explicitExpire = parseZohoDate(expF.value) || parseZohoDate(expF.value_formatted);
        }
      }

      let warrantyMonths = detectWarrantyMonths(itemName, item.description || '', sku);
      let expireDate = explicitExpire;
      if (!expireDate && invDate) {
        expireDate = calculateExpiryDate(invDate, warrantyMonths);
      }

      if (!expireDate) continue;

      // Only include items that expired ON or AFTER minExpireDate (2024-04-01 onwards)
      if (expireDate < minExpireDate) continue;

      const expD = new Date(expireDate);
      expD.setHours(0, 0, 0, 0);
      const daysRemaining = Math.floor((expD - today) / (1000 * 60 * 60 * 24));
      const isExpired = daysRemaining < 0;
      const status = isExpired ? 'EXPIRED' : (daysRemaining <= 30 ? 'EXPIRING_SOON' : 'ACTIVE');

      const itemRate = Number(item.rate || 0);
      const quantity = Number(item.quantity || 1);
      const subTotal = Number(item.item_total || (itemRate * quantity) || 0);

      // Extract serial numbers
      let serials = [];
      if (Array.isArray(item.serial_numbers) && item.serial_numbers.length > 0) {
        serials = item.serial_numbers.map(s => typeof s === 'object' ? s.serial_number : String(s).trim()).filter(Boolean);
      } else if (Array.isArray(item.serial_number_details) && item.serial_number_details.length > 0) {
        serials = item.serial_number_details.map(s => String(s.serial_number || '').trim()).filter(Boolean);
      }

      const baseRow = {
        expire_date: expireDate,
        item_name: itemName,
        sku: sku || '—',
        invoice_date: invDate || 'N/A',
        currency: currencyCode,
        sub_total: itemRate.toFixed(2),
        total_line_sub_total: subTotal.toFixed(2),
        invoice_number: invNumber,
        customer_name: customerName,
        warranty_months: warrantyMonths,
        days_expired: isExpired ? Math.abs(daysRemaining) : 0,
        days_remaining: daysRemaining,
        status: status,
        invoice_status: invoice.status || invSummary.status || ''
      };

      if (serials.length > 0) {
        for (const sn of serials) reportRecords.push({ ...baseRow, serial_number: sn });
      } else {
        reportRecords.push({ ...baseRow, serial_number: 'Non-serialized' });
      }
    }
  }

  // Sort by Expire Date descending
  reportRecords.sort((a, b) => (b.expire_date || '').localeCompare(a.expire_date || ''));

  const expiredList = reportRecords.filter(r => r.status === 'EXPIRED');

  console.log('\n=============================================');
  console.log(`✅ SYNC COMPLETE!`);
  console.log(`Total database items: ${reportRecords.length}`);
  console.log(`Total Expired items (since ${minExpireDate}): ${expiredList.length}`);
  console.log(`Expiring soon (<=30d): ${reportRecords.filter(r => r.status === 'EXPIRING_SOON').length}`);
  console.log(`Active items: ${reportRecords.filter(r => r.status === 'ACTIVE').length}`);
  console.log('=============================================\n');

  // Write to latest_report.json
  const outPath = path.join(__dirname, 'latest_report.json');
  fs.writeFileSync(outPath, JSON.stringify(reportRecords, null, 2));
  console.log(`Saved ${reportRecords.length} records to ${outPath}`);
}

main().catch(console.error);
