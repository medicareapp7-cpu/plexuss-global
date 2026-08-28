/**
 * Authorize new Zoho Account / Org with a Grant Token (Code) from Zoho API Console (Self Client)
 * Usage: node auth_code.js <grant_token_code>
 */

const fs = require('fs');
const path = require('path');

// Zero-dependency .env loader
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
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const CLIENT_ID = process.env.ZOHO_CLIENT_ID || "1000.60T24PKMTMV3TC2HOEMXDB3PNJZX9F";
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || "ec379df0a288f63c59546f33cb821676e78407c5f3";
const TOKENS_PATH = path.join(__dirname, 'tokens.json');

async function exchangeCode(code) {
  if (!code) {
    console.error('Please provide the grant code. Example: node auth_code.js 1000.xxxxxxxxxxxx');
    process.exit(1);
  }

  console.log(`Exchanging Grant Code for Refresh Token...`);
  const url = `https://accounts.zoho.com/oauth/v2/token?code=${code.trim()}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&grant_type=authorization_code`;
  
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json();
  console.log('Zoho Response:', JSON.stringify(data, null, 2));

  if (data.access_token) {
    const tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || (fs.existsSync(TOKENS_PATH) ? JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')).refresh_token : ''),
      api_domain: data.api_domain || "https://www.zohoapis.com",
      token_type: "Bearer",
      expires_in: data.expires_in || 3600,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000
    };
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');

    // Update .env with new Org ID
    if (fs.existsSync(envPath)) {
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/ZOHO_ORG_ID=\d+/, 'ZOHO_ORG_ID=815849495');
      if (!envContent.includes('ZOHO_ORG_ID')) {
        envContent += '\nZOHO_ORG_ID=815849495';
      }
      fs.writeFileSync(envPath, envContent, 'utf8');
    }

    console.log('\n✅ Authorization successful! New tokens saved for Organization 815849495.');
    console.log('Now you can run: node generate_report.js');
  } else {
    console.error('❌ Failed to get access token. Error:', data.error || data);
  }
}

const code = process.argv[2];
exchangeCode(code).catch(console.error);
