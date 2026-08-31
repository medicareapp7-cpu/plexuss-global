const fs = require('fs');
const path = require('path');

// 1. Read CSV: expired_products_report_2026-08-25.csv
const csvPath = path.join(__dirname, 'expired_products_report_2026-08-25.csv');
const csvContent = fs.readFileSync(csvPath, 'utf8');

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  // Parse header
  const header = parseCSVLine(lines[0]);
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < 5) continue;

    const row = {};
    for (let h = 0; h < header.length; h++) {
      const key = header[h].toLowerCase().replace(/[\s\(\)]+/g, '_').replace(/^_|_$/g, '');
      row[key] = values[h] || '';
    }
    records.push(row);
  }
  return records;
}

function parseCSVLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

console.log('Parsing CSV...');
const csvRecords = parseCSV(csvContent);
console.log(`Parsed ${csvRecords.length} records from CSV.`);

// Map CSV records to standard report schema
const today = new Date();
today.setHours(0, 0, 0, 0);

const mappedCsvRecords = csvRecords.map(r => {
  const expDate = r.expire_date || '';
  const invDate = r.invoice_date || '';
  const subTotal = parseFloat(r.sub_total || 0).toFixed(2);
  const warranty = parseInt(r.warranty_months || '12', 10);
  
  let daysRemaining = 0;
  let isExpired = true;
  if (expDate) {
    const d = new Date(expDate);
    if (!isNaN(d.getTime())) {
      d.setHours(0, 0, 0, 0);
      daysRemaining = Math.floor((d - today) / (1000 * 60 * 60 * 24));
      isExpired = daysRemaining < 0;
    }
  }

  const status = isExpired ? 'EXPIRED' : (daysRemaining <= 30 ? 'EXPIRING_SOON' : 'ACTIVE');

  return {
    expire_date: expDate,
    item_name: r.item_name || 'Unnamed Item',
    sku: r.sku || '—',
    serial_number: r.serial_number || 'Non-serialized',
    invoice_date: invDate,
    currency: r.currency || 'USD',
    sub_total: subTotal,
    total_line_sub_total: subTotal,
    invoice_number: r.invoice_number || '',
    customer_name: r.customer_name || '',
    warranty_months: warranty,
    days_expired: isExpired ? Math.abs(daysRemaining) : 0,
    days_remaining: daysRemaining,
    status: status,
    invoice_status: 'paid'
  };
});

// 2. Read existing latest_report.json (LKR records)
const lkrPath = path.join(__dirname, 'latest_report.json');
let lkrRecords = [];
if (fs.existsSync(lkrPath)) {
  try {
    lkrRecords = JSON.parse(fs.readFileSync(lkrPath, 'utf8'));
  } catch (_) {}
}

console.log(`Loaded ${lkrRecords.length} records from current latest_report.json.`);

// 3. Combine both datasets, deduplicating by invoice_number + sku + serial_number
const seen = new Set();
const combined = [];

for (const r of mappedCsvRecords) {
  const key = `${r.invoice_number}_${r.sku}_${r.serial_number}`;
  if (!seen.has(key)) {
    seen.add(key);
    combined.push(r);
  }
}

for (const r of lkrRecords) {
  const key = `${r.invoice_number}_${r.sku}_${r.serial_number}`;
  if (!seen.has(key)) {
    seen.add(key);
    combined.push(r);
  }
}

// Sort by Invoice Date descending (Newest first)
combined.sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));

console.log(`\n======================================================`);
console.log(`✅ UNIFIED DATABASE BUILT:`);
console.log(`   Total Records: ${combined.length}`);
console.log(`   Expired Items: ${combined.filter(r => r.status === 'EXPIRED').length}`);
console.log(`   Active Items:  ${combined.filter(r => r.status === 'ACTIVE').length}`);
console.log(`======================================================\n`);

// Save to latest_report.json
fs.writeFileSync(path.join(__dirname, 'latest_report.json'), JSON.stringify(combined, null, 2), 'utf8');
console.log('Saved to latest_report.json successfully!');
