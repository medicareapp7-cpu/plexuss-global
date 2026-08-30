/**
 * Zoho Books Expired Products & Warranty Report Generator
 * 
 * Extracts:
 * - Expire Date (Supports Zoho Books 'cf_warranty_expired' / 'Warranty Expired' / 'cf_sla_period' & heuristic calculations)
 * - Item Name
 * - SKU
 * - Serial Number
 * - Invoice Date
 * - Currency
 * - Sub Total (Item Total)
 * - Invoice Number
 * - Customer Name
 */

const fs = require('fs');
const path = require('path');

// Zero-dependency .env loader
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
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (_) {}

const TOKENS_PATH = path.join(__dirname, 'tokens.json');

const CLIENT_ID = process.env.ZOHO_CLIENT_ID || "1000.60T24PKMTMV3TC2HOEMXDB3PNJZX9F";
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "ec379df0a288f63c59546f33cb821676e78407c5f3";
const ORG_ID = process.env.ZOHO_ORG_ID || "815849495";
const DEFAULT_WARRANTY_MONTHS = parseInt(process.env.DEFAULT_WARRANTY_MONTHS || "12", 10);
const FALLBACK_REFRESH_TOKEN = "1000.5b1ed0025d3641c7f22860229301c001.f649ff65d36b20da5664ec563cd41a16";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function getStoredTokens() {
  const refreshToken = (process.env.ZOHO_REFRESH_TOKEN && process.env.ZOHO_REFRESH_TOKEN.trim()) || FALLBACK_REFRESH_TOKEN;
  if (refreshToken) {
    return {
      refresh_token: refreshToken,
      access_token: process.env.ZOHO_ACCESS_TOKEN || "",
      expires_at: parseInt(process.env.ZOHO_EXPIRES_AT || "0", 10),
    };
  }
  try {
    if (fs.existsSync(TOKENS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
      if (parsed && parsed.refresh_token) return parsed;
    }
  } catch (_) {}
  try {
    const tmpTokens = path.join(os.tmpdir(), 'tokens.json');
    if (fs.existsSync(tmpTokens)) {
      const parsed = JSON.parse(fs.readFileSync(tmpTokens, 'utf8'));
      if (parsed && parsed.refresh_token) return parsed;
    }
  } catch (_) {}
  return null;
}

const os = require('os');

function saveTokens(tokens) {
  cachedToken = tokens.access_token;
  cachedTokenExpiresAt = tokens.expires_at;
  try {
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  } catch (_) {
    try {
      fs.writeFileSync(path.join(os.tmpdir(), 'tokens.json'), JSON.stringify(tokens, null, 2));
    } catch (_) {}
  }
}

async function refreshAccessToken(refreshToken) {
  const url = `https://accounts.zoho.com/oauth/v2/token?refresh_token=${refreshToken}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Failed to refresh token: ' + JSON.stringify(data));
  }
  cachedToken = data.access_token;
  cachedTokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  const tokens = getStoredTokens() || {};
  tokens.access_token = data.access_token;
  tokens.expires_at = cachedTokenExpiresAt;
  saveTokens(tokens);
  return data.access_token;
}

async function getAccessToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && cachedTokenExpiresAt && Date.now() < cachedTokenExpiresAt - 60000) {
    return cachedToken;
  }
  const tokens = getStoredTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('No OAuth tokens found. Check .env or tokens.json');
  }
  if (!forceRefresh && tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60000) {
    cachedToken = tokens.access_token;
    cachedTokenExpiresAt = tokens.expires_at;
    return tokens.access_token;
  }
  return await refreshAccessToken(tokens.refresh_token);
}

async function apiRequest(method, endpoint, body = null, isRetry = false) {
  let accessToken = await getAccessToken(isRetry);
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = `https://www.zohoapis.com/books/v3${endpoint}${separator}organization_id=${ORG_ID}`;
  const options = {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }

  if ((res.status === 401 || (parsed && (parsed.code === 57 || parsed.code === 14))) && !isRetry) {
    const tokens = getStoredTokens();
    if (tokens && tokens.refresh_token) {
      accessToken = await refreshAccessToken(tokens.refresh_token);
      return apiRequest(method, endpoint, body, true);
    }
  }

  return { status: res.status, data: parsed };
}

/**
 * Normalizes all Zoho date formats (YYYY-MM-DD, DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY) to standard ISO YYYY-MM-DD
 */
function parseZohoDate(val) {
  if (!val) return null;
  val = String(val).trim();
  if (!val || val === 'dd.MM.yyyy' || val === 'N/A' || val.toLowerCase() === 'null') return null;

  // 1. ISO format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return val;
  }

  // 2. European / Zoho format: DD.MM.YYYY or DD/MM/YYYY or DD-MM-YYYY
  const dmyMatch = val.match(/^(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // 3. Fallback to JS Date object
  const d = new Date(val);
  if (!isNaN(d.getTime())) {
    return d.toISOString().split('T')[0];
  }

  return null;
}

/** 
 * Comprehensive Warranty Duration Detector
 * Analyzes Item Name, Description, SKU and Part Numbers (e.g. Fortinet, HPE, Aruba, Zyxel, Silver Peak)
 */
function detectWarrantyMonths(name = '', description = '', sku = '') {
  const text = `${name} ${description} ${sku}`.toLowerCase();

  // 1. Explicit 5-Year Patterns (60 Months)
  if (
    /\b5\s*(?:years?|yrs?|y)\b/i.test(text) ||
    /\b5y\s*(?:support|warranty|maint|contract|sub|protection)\b/i.test(text) ||
    /[-_]60\b/i.test(sku) ||
    /[-_]5yr?\b/i.test(sku) ||
    /\b60\s*(?:months?|mos?|m)\b/i.test(text)
  ) return 60;

  // 2. Explicit 4-Year Patterns (48 Months)
  if (
    /\b4\s*(?:years?|yrs?|y)\b/i.test(text) ||
    /\b4y\s*(?:support|warranty|maint|contract|sub|protection)\b/i.test(text) ||
    /[-_]48\b/i.test(sku) ||
    /[-_]4yr?\b/i.test(sku) ||
    /\b48\s*(?:months?|mos?|m)\b/i.test(text)
  ) return 48;

  // 3. Explicit 3-Year Patterns (36 Months)
  if (
    /\b3\s*(?:years?|yrs?|y)\b/i.test(text) ||
    /\b3y\s*(?:support|warranty|maint|contract|sub|protection|fc|nbd)\b/i.test(text) ||
    /[-_]36\b/i.test(sku) ||
    /[-_]3yr?\b/i.test(sku) ||
    /\b36\s*(?:months?|mos?|m)\b/i.test(text) ||
    text.includes('3yr-maint') ||
    text.includes('3 year') ||
    text.includes('3year')
  ) return 36;

  // 4. Explicit 2-Year Patterns (24 Months)
  if (
    /\b2\s*(?:years?|yrs?|y)\b/i.test(text) ||
    /\b2y\s*(?:support|warranty|maint|contract|sub|protection)\b/i.test(text) ||
    /[-_]24\b/i.test(sku) ||
    /[-_]2yr?\b/i.test(sku) ||
    /\b24\s*(?:months?|mos?|m)\b/i.test(text) ||
    text.includes('2yr-maint') ||
    text.includes('2 year') ||
    text.includes('2year')
  ) return 24;

  // 5. Explicit 1-Year Patterns (12 Months)
  if (
    /\b1\s*(?:years?|yrs?|y)\b/i.test(text) ||
    /\b1y\s*(?:support|warranty|maint|contract|sub|protection|fc|nbd)\b/i.test(text) ||
    /[-_]12\b/i.test(sku) ||
    /[-_]1yr?\b/i.test(sku) ||
    /\b12\s*(?:months?|mos?|m)\b/i.test(text) ||
    text.includes('1yr-maint') ||
    text.includes('1 year') ||
    text.includes('1year') ||
    text.includes('01 year')
  ) return 12;

  // 6. Explicit Sub-Year Month Patterns (6 Months, 3 Months, 1 Month)
  if (
    /\b(?:0?6)\s*(?:months?|mos?)\b/i.test(text) ||
    /[-_]0?6m\b/i.test(sku) ||
    text.includes('6m') ||
    text.includes('06 month')
  ) return 6;

  if (
    /\b(?:0?3)\s*(?:months?|mos?)\b/i.test(text) ||
    /[-_]0?3m\b/i.test(sku) ||
    text.includes('3 month') ||
    text.includes('03 month')
  ) return 3;

  if (
    /\b(?:0?1)\s*(?:months?|mos?|mo)\b/i.test(text) ||
    /1mo-maint/i.test(text) ||
    /1mo/i.test(sku) ||
    text.includes('1 month') ||
    text.includes('01 month')
  ) return 1;

  return DEFAULT_WARRANTY_MONTHS;
}

/** Calculate expiry date from invoice date and warranty months */
function calculateExpiryDate(dateStr, warrantyMonths) {
  if (!dateStr) return null;
  const isoDate = parseZohoDate(dateStr);
  if (!isoDate) return null;
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + warrantyMonths);
  return d.toISOString().split('T')[0];
}

/**
 * Extracts Expiry Date ONLY from the explicit Zoho Books 'WARRANTY EXPIRED' (cf_warranty_expired) custom field.
 * If this field is not set in Zoho, returns null (no fallback calculation).
 * 
 * Rule: A product is EXPIRED only if its WARRANTY EXPIRED date from Zoho has passed today.
 */
function extractLineItemExpiryDate(item) {
  const possibleApiNames = [
    'cf_warranty_expired',
    'cf_warranty_expiry',
    'cf_warranty_expire',
    'cf_warranty_expiry_date',
    'cf_expiry_date',
  ];

  const possibleLabels = [
    'warranty expired',
    'warranty expiry',
    'warranty expire',
    'expiry date',
  ];

  // 1. Check direct cf_ properties on item object
  for (const key of possibleApiNames) {
    if (item[key]) {
      const parsed = parseZohoDate(item[key]);
      if (parsed) return { expireDate: parsed, isExplicit: true };
    }
  }

  // 2. Check item_custom_fields array (Zoho line item custom fields)
  const fieldArrays = [
    item.item_custom_fields,
    item.line_item_custom_fields,
    item.custom_fields
  ];

  for (const arr of fieldArrays) {
    if (!Array.isArray(arr)) continue;
    for (const field of arr) {
      const apiName = String(field.api_name || '').toLowerCase().trim();
      const label = String(field.label || '').toLowerCase().trim();

      const isWarrantyField = possibleApiNames.includes(apiName) ||
                              possibleLabels.includes(label) ||
                              apiName.includes('warranty_expir') ||
                              label.includes('warranty expir');

      if (!isWarrantyField) continue;

      // Prefer ISO value first, then value_formatted
      const isoVal = parseZohoDate(field.value);
      if (isoVal) return { expireDate: isoVal, isExplicit: true };

      const fmtVal = parseZohoDate(field.value_formatted);
      if (fmtVal) return { expireDate: fmtVal, isExplicit: true };
    }
  }

  // 3. No WARRANTY EXPIRED date found in Zoho → do NOT estimate from invoice date
  return { expireDate: null, isExplicit: false };
}

const INVOICE_CACHE_PATH = path.join(__dirname, 'invoices_cache.json');

function loadInvoiceCache() {
  try {
    if (fs.existsSync(INVOICE_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(INVOICE_CACHE_PATH, 'utf8'));
    }
  } catch (_) {
    try {
      const tmpPath = path.join(os.tmpdir(), 'invoices_cache.json');
      if (fs.existsSync(tmpPath)) {
        return JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      }
    } catch (_) {}
  }
  return {};
}

function saveInvoiceCache(cache) {
  try {
    fs.writeFileSync(INVOICE_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
  } catch (_) {
    try {
      fs.writeFileSync(path.join(os.tmpdir(), 'invoices_cache.json'), JSON.stringify(cache, null, 2), 'utf8');
    } catch (_) {}
  }
}

/** Main extraction function */
async function extractAllExpiredProducts(options = {}) {
  const onlyExpired = options.onlyExpired !== false; // default true
  const customWarrantyMonths = options.warrantyMonths || DEFAULT_WARRANTY_MONTHS;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  console.log(`[Report] Starting invoice extraction for Organization ID: ${ORG_ID}`);
  console.log(`[Report] Default Warranty Months: ${customWarrantyMonths}, Filter Only Expired: ${onlyExpired}`);

  let allInvoicesSummary = [];
  let page = 1;
  const perPage = 200;

  // 1. Fetch all invoices metadata for Org (1 API call per 200 invoices)
  while (true) {
    console.log(`[Report] Fetching invoice list page ${page} for Org ${ORG_ID}...`);
    const res = await apiRequest('GET', `/invoices?page=${page}&per_page=${perPage}&sort_column=date&sort_order=D`);
    if (res.status >= 400 || !res.data || !res.data.invoices) {
      console.warn(`[Report] Finished or failed at page ${page}:`, res.data?.message || res.status);
      break;
    }
    const list = res.data.invoices || [];
    if (list.length === 0) break;
    allInvoicesSummary.push(...list);
    if (!res.data.page_context?.has_more_page) break;
    page++;
  }

  console.log(`[Report] Total invoices found: ${allInvoicesSummary.length}. Checking local cache to minimize API usage...`);

  const invoiceCache = loadInvoiceCache();
  const maxInvoicesToProcess = options.limit || allInvoicesSummary.length;
  const targetInvoices = allInvoicesSummary.slice(0, maxInvoicesToProcess);

  // 2. Only fetch invoices that are not in cache or have been modified since last sync
  const invoicesToFetch = targetInvoices.filter(inv => {
    const cached = invoiceCache[inv.invoice_id];
    if (!cached || !cached.invoice) return true;
    if (inv.last_modified_time && cached.last_modified_time !== inv.last_modified_time) return true;
    return false;
  });

  console.log(`[Report] Invoices to fetch from Zoho API: ${invoicesToFetch.length} (Reusing ${targetInvoices.length - invoicesToFetch.length} from cache — saved ${targetInvoices.length - invoicesToFetch.length} API calls!)`);

  const BATCH_SIZE = 15;
  let fetchedCount = 0;

  if (invoicesToFetch.length > 0) {
    for (let i = 0; i < invoicesToFetch.length; i += BATCH_SIZE) {
      const batch = invoicesToFetch.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (inv) => {
        try {
          const detailRes = await apiRequest('GET', `/invoices/${inv.invoice_id}`);
          if (detailRes.status >= 400 || !detailRes.data || !detailRes.data.invoice) return;
          const invoice = detailRes.data.invoice;
          invoiceCache[inv.invoice_id] = {
            invoice: invoice,
            last_modified_time: inv.last_modified_time || invoice.last_modified_time || ''
          };
        } catch (err) {}
      }));

      fetchedCount = Math.min(fetchedCount + batch.length, invoicesToFetch.length);
      const pct = Math.round((fetchedCount / invoicesToFetch.length) * 100);
      process.stdout.write(`[Report] Fetched ${fetchedCount}/${invoicesToFetch.length} new invoices (${pct}%)...\r`);
      await new Promise(r => setTimeout(r, 60));
    }
    console.log(`\n[Report] Saved new invoices to cache.`);
    saveInvoiceCache(invoiceCache);
  }

  // 3. Process all invoices from cache (instant, 0 additional API calls)
  const reportRecords = [];

  for (const inv of targetInvoices) {
    const cachedEntry = invoiceCache[inv.invoice_id];
    if (!cachedEntry || !cachedEntry.invoice) continue;
    const invoice = cachedEntry.invoice;

    const invNumber = invoice.invoice_number || inv.invoice_number || '';
    const rawInvDate = invoice.date || inv.date || '';
    const invDate = parseZohoDate(rawInvDate) || rawInvDate || '';
    const customerName = invoice.customer_name || inv.customer_name || '';
    const currencyCode = invoice.currency_code || inv.currency_code || 'USD';

    const lineItems = invoice.line_items || [];
    for (const item of lineItems) {
      const itemName = item.name || item.description || 'Unnamed Item';
      
      // Ignore opening balance dummy items
      if (itemName.toUpperCase() === 'OPB' || (item.sku && item.sku.toUpperCase() === 'OPB')) {
        continue;
      }

      // Exact SKU from line item or custom field
      let sku = item.sku || '';
      if (!sku && Array.isArray(item.item_custom_fields)) {
        const skuField = item.item_custom_fields.find(f => 
          f.api_name === 'cf_sku' || 
          f.api_name === 'cf_part_no' || 
          f.label === 'Part No' || 
          f.label === 'SKU'
        );
        if (skuField) sku = skuField.value || skuField.value_formatted || '';
      }

      const itemRate = Number(item.rate || 0);
      const quantity = Number(item.quantity || 1);
      const subTotal = Number(item.item_total || (itemRate * quantity) || 0);

      // Extract Expiry Date ONLY from Zoho WARRANTY EXPIRED (cf_warranty_expired) custom field
      const expiryInfo = extractLineItemExpiryDate(item);

      // Skip items that have no WARRANTY EXPIRED date set in Zoho Books
      if (!expiryInfo.expireDate) continue;

      const expireDate = expiryInfo.expireDate;

      // Calculate warranty duration from invoice date → expiry date (for display only)
      let warrantyMonths = customWarrantyMonths;
      if (invDate) {
        const d1 = new Date(invDate);
        const d2 = new Date(expireDate);
        if (!isNaN(d1.getTime()) && !isNaN(d2.getTime())) {
          const diff = (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth());
          if (diff > 0) warrantyMonths = diff;
        }
      }

      // Determine status from WARRANTY EXPIRED date vs today
      const expDateObj = new Date(expireDate);
      expDateObj.setHours(0, 0, 0, 0);
      const daysRemaining = Math.floor((expDateObj - today) / (1000 * 60 * 60 * 24));
      const isExpired = daysRemaining < 0;
      const status = isExpired ? 'EXPIRED' : (daysRemaining <= 30 ? 'EXPIRING_SOON' : 'ACTIVE');

      // Extract Serial Numbers
      let serialNumbers = [];
      if (Array.isArray(item.serial_numbers) && item.serial_numbers.length > 0) {
        serialNumbers = item.serial_numbers.map(s => typeof s === 'object' ? (s.serial_number || JSON.stringify(s)) : String(s).trim()).filter(Boolean);
      } else if (Array.isArray(item.serial_number_details) && item.serial_number_details.length > 0) {
        serialNumbers = item.serial_number_details.map(s => String(s.serial_number || '').trim()).filter(Boolean);
      }

      // Build base row
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
        invoice_status: invoice.status || inv.status || ''
      };

      // Generate row per serial number, or one row for non-serialized items
      if (serialNumbers.length > 0) {
        for (const sn of serialNumbers) {
          const row = { ...baseRow, serial_number: sn };
          if (!onlyExpired || isExpired) reportRecords.push(row);
        }
      } else {
        const row = { ...baseRow, serial_number: 'Non-serialized' };
        if (!onlyExpired || isExpired) reportRecords.push(row);
      }
    }
  }

  console.log(`\n[Report] Processing complete! Found ${reportRecords.length} records matching criteria for Org ID ${ORG_ID}.`);

  // Sort by Invoice Date descending (Newest invoices first)
  reportRecords.sort((a, b) => {
    return (b.invoice_date || '').localeCompare(a.invoice_date || '');
  });

  return reportRecords;
}

/** Convert array of objects to CSV string with Currency */
function toCSV(records) {
  const headers = [
    'Expire Date',
    'Item Name',
    'SKU',
    'Serial Number',
    'Invoice Date',
    'Currency',
    'Sub Total',
    'Invoice Number',
    'Customer Name',
    'Warranty (Months)',
    'Days Expired',
    'Status'
  ];

  const rows = records.map(r => [
    r.expire_date,
    r.item_name,
    r.sku,
    r.serial_number,
    r.invoice_date,
    r.currency || 'USD',
    r.sub_total,
    r.invoice_number,
    r.customer_name,
    r.warranty_months,
    r.days_expired,
    r.status
  ].map(field => `"${String(field || '').replace(/"/g, '""')}"`).join(','));

  return [headers.join(','), ...rows].join('\r\n');
}

// Standalone CLI execution
if (require.main === module) {
  (async () => {
    try {
      // 1. Extract ALL products (Expired + Expiring Soon + Active) for full intelligence & dashboard
      const allRecords = await extractAllExpiredProducts({ onlyExpired: false });
      
      // 2. Save full dataset to latest_report.json for Web UI
      fs.writeFileSync(path.join(__dirname, 'latest_report.json'), JSON.stringify(allRecords, null, 2), 'utf8');

      // 3. Save Expired CSV report for Excel
      const expiredRecords = allRecords.filter(r => r.status === 'EXPIRED');
      const todayStr = new Date().toISOString().split('T')[0];
      const filename = `expired_products_report_${todayStr}.csv`;
      const outPath = path.join(__dirname, filename);
      fs.writeFileSync(outPath, toCSV(expiredRecords), 'utf8');

      console.log(`\n✅ REPORT GENERATED SUCCESSFULLY!`);
      console.log(`📁 CSV File saved to: ${outPath} (${expiredRecords.length} expired items)`);
      console.log(`📁 JSON Database saved to: latest_report.json (${allRecords.length} total items)`);
      console.log(`📊 Summary Breakdown:`);
      console.log(`   - 🔴 Expired: ${expiredRecords.length}`);
      console.log(`   - ⚠️ Expiring Soon (<=30d): ${allRecords.filter(r => r.status === 'EXPIRING_SOON').length}`);
      console.log(`   - ✅ Active: ${allRecords.filter(r => r.status === 'ACTIVE').length}`);
      
      // Print sample preview
      if (allRecords.length > 0) {
        console.log('\n--- SAMPLE 5 RECORDS PREVIEW ---');
        console.table(allRecords.slice(0, 5).map(r => ({
          'Expire Date': r.expire_date,
          'Item Name': r.item_name.substring(0, 30),
          'SKU': r.sku,
          'Serial Number': r.serial_number,
          'Inv Date': r.invoice_date,
          'Currency': r.currency,
          'Sub Total': r.sub_total,
          'Status': r.status,
          'Customer': r.customer_name.substring(0, 25)
        })));
      }
    } catch (err) {
      console.error('Fatal error during report generation:', err);
    }
  })();
}

module.exports = {
  extractAllExpiredProducts,
  toCSV,
  detectWarrantyMonths,
  calculateExpiryDate,
  extractLineItemExpiryDate,
  parseZohoDate
};
