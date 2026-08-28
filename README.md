# 🛡️ Zoho Books Expired Products & Warranty Report Tool

මෙම Tool එක මඟින් **Zoho Books** සමඟ සෘජුව සම්බන්ධ වී, ආයතනයේ නිකුත් කරන ලද සියලුම Invoices extract කර, එක් එක් භාණ්ඩයේ (සහ Serial Number එකේ) **Warranty Expire Date** එක ගණනය කර, Expired වූ සියලුම products වල විස්තර වාර්තාවක් (Report / CSV / Dashboard) ලබාදෙයි.

---

## 📋 අඩංගු වන දත්ත (Report Columns)
1. **Expire Date** (කල් ඉකුත් වූ දිනය)
2. **Item Name** (භාණ්ඩයේ නම)
3. **SKU** (Item Code / SKU)
4. **Serial Number** (අදාළ Serial Number එක)
5. **Invoice Date** (බිල්පත් දිනය)
6. **Currency** (මුදල් ඒකකය - USD / LKR)
7. **Sub Total** (භාණ්ඩයේ ඒකක වටිනාකම)
8. **Invoice Number** (Invoice අංකය)
9. **Customer Name** (පාරිභෝගිකයාගේ නම)
10. **Warranty Months** & **Days Expired**

---

## 🚀 භාවිත කරන ආකාරය (How to Use)

### ක්‍රමය 1: Interactive Web Dashboard එක Run කිරීම (Recommended)
Terminal / Command Prompt එකෙහි පහත command එක run කරන්න:
```bash
npm start
# හෝ
node server.js
```
ඉන්පසු ඔබගේ Browser එකෙන් **`http://localhost:3000`** වෙත පිවිසෙන්න.
- 🔄 **Sync From Zoho** බොත්තම ක්ලික් කිරීමෙන් Organization ID: 815849495 එකෙන් අලුත්ම Invoices සියල්ල direct sync කරගත හැක.
- 🔴 Expired / ⚠️ Expiring Soon / 📋 All filters
- Live Instant Search (Customer, SKU, Serial Number, Product)
- **1-Click "Export Expired (CSV)"** download button
- **Save as PDF / Print** (A4 Landscape Print-ready format)

---

### ක්‍රමය 2: සෘජුවම CSV Report File එකක් Generate කරගැනීම (CLI)
```bash
node generate_report.js
```
මෙය run කළ පසු එම folder එක තුළම:
- `expired_products_report_YYYY-MM-DD.csv` ගොනුවක් සෑදේ (Excel වලින් විවෘත කළ හැක).
- `latest_report.json` ගොනුව dashboard එක සඳහා update වේ.

---

## ⚙️ Settings / Credentials
`.env` ගොනුව තුළ ඔබගේ Zoho OAuth credentials අඩංගු වේ:
```env
ZOHO_CLIENT_ID=1000.60T24PKMTMV3TC2HOEMXDB3PNJZX9F
ZOHO_CLIENT_SECRET=ec379df0a288f63c59546f33cb821676e78407c5f3
ZOHO_ORG_ID=815849495
DEFAULT_WARRANTY_MONTHS=12
```
