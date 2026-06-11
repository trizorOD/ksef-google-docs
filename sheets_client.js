const { google } = require('googleapis');
const fs = require('fs');
const http = require('http');
const url = require('url');
const config = require('./config');

const SHEET_ID = config.google.sheetId;
const OAUTH_CLIENT_PATH = './oauth-client.json';
const TOKEN_PATH = './token.json';
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

// Extra columns prepended to the outgoing (Subject1) sheet
const EXTRA_SALE_COLUMNS = [
  'invoiceNumber',
  'buyerName',
  'issueDate',
  'acquisitionDate',
  'dueDatePlaceholder',
  'paymentDatePlaceholder',
  'grossAmount',
  'paymentStatusPlaceholder',
  'isCorrectiveInvoice',
  'driveLink',
];

const EXTRA_SALE_HEADERS = [
  'Invoice',
  'Buyer',
  'Issue date',
  'Date added to KSeF',
  'Due date',
  'Date of payment',
  'Sum',
  'Status of payment',
  'Corrective invoice',
  'Link to invoice',
];

// Extra columns prepended to the incoming (Subject2) sheet
const EXTRA_PURCHASE_COLUMNS = [
  'invoiceNumber',
  'grossAmount',
  'paymentStatusPlaceholder',
  'issueDate',
  'acquisitionDate',
  'paymentDatePlaceholder',
  'dueDatePlaceholder',
  'commentsPlaceholder',
  'sellerName',
  'paymentMethodPlaceholder',
  'driveLink',
  'correctiveDriveLink',
];

const EXTRA_PURCHASE_HEADERS = [
  'No of invoice',
  'Sum',
  'Status of payment',
  'Issue date',
  'Date added to KSeF',
  'Date of payment',
  'Due date',
  '',
  'Seller',
  'Method of payment',
  'Link to invoice',
  'Link to corrective invoice',
];

// Base columns for outgoing (Sprzedaż / Subject1) — trimmed set
const COLUMNS_SALE = [
  'ksefNumber',
  'netAmount',
  'grossAmount',
  'vatAmount',
];

const HEADERS_SALE = [
  'Numer KSeF',
  'Kwota netto',
  'Kwota brutto',
  'Kwota VAT',
];

// Base columns for incoming (Zakupy / Subject2) — trimmed set
const COLUMNS_PURCHASE = [
  'ksefNumber',
  'sellerNip',
];

const HEADERS_PURCHASE = [
  'Numer KSeF',
  'NIP sprzedawcy',
];

// Base columns for incoming (Zakupy / Subject2) — full set
const COLUMNS = [
  'ksefNumber',
  'invoiceNumber',
  'issueDate',
  'invoicingDate',
  'acquisitionDate',
  'permanentStorageDate',
  'sellerNip',
  'sellerName',
  'buyerIdentifierType',
  'buyerIdentifierValue',
  'buyerName',
  'netAmount',
  'grossAmount',
  'vatAmount',
  'currency',
  'invoicingMode',
  'invoiceType',
  'formCodeSystemCode',
  'isSelfInvoicing',
  'hasAttachment',
];

const HEADERS = [
  'Numer KSeF',
  'Numer faktury',
  'Data wystawienia',
  'Data fakturowania',
  'Data nabycia',
  'Data trwałego przechowywania',
  'NIP sprzedawcy',
  'Nazwa sprzedawcy',
  'Typ ID nabywcy',
  'ID nabywcy',
  'Nazwa nabywcy',
  'Kwota netto',
  'Kwota brutto',
  'Kwota VAT',
  'Waluta',
  'Tryb fakturowania',
  'Typ faktury',
  'Kod formularza',
  'Samofakturowanie',
  'Załącznik',
];

// OAuth2: open browser for consent, get token, save to token.json
function getAuthClient() {
  if (!fs.existsSync(OAUTH_CLIENT_PATH)) {
    throw new Error(`OAuth client file not found: ${OAUTH_CLIENT_PATH}`);
  }
  const { installed } = JSON.parse(fs.readFileSync(OAUTH_CLIENT_PATH, 'utf8'));
  return new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    'http://localhost:3001/oauth2callback'
  );
}

async function authorize() {
  const oAuth2Client = getAuthClient();

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    // Auto-save refreshed tokens
    oAuth2Client.on('tokens', (tokens) => {
      const current = fs.existsSync(TOKEN_PATH)
        ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
        : {};
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }));
    });
    return oAuth2Client;
  }

  return getNewToken(oAuth2Client);
}

function getNewToken(oAuth2Client) {
  return new Promise((resolve, reject) => {
    const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });

    console.log('\n--- Google OAuth2 Authorization Required ---');
    console.log('Opening browser for authorization...');
    console.log('If browser does not open, visit this URL manually:\n');
    console.log(authUrl);
    console.log('\n--------------------------------------------\n');

    // Try to open browser
    const open = (u) => {
      const { exec } = require('child_process');
      const cmd =
        process.platform === 'win32'
          ? `start "" "${u}"`
          : process.platform === 'darwin'
          ? `open "${u}"`
          : `xdg-open "${u}"`;
      exec(cmd);
    };
    open(authUrl);

    // Local callback server on port 3001
    const server = http.createServer(async (req, res) => {
      const parsed = url.parse(req.url, true);
      if (parsed.pathname !== '/oauth2callback') return;

      const code = parsed.query.code;
      if (!code) {
        res.end('No code received.');
        server.close();
        return reject(new Error('OAuth: no code in callback'));
      }

      res.end('<html><body><h2>Authorization successful! You can close this tab.</h2></body></html>');
      server.close();

      try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
        console.log('Google OAuth2: token saved to', TOKEN_PATH);
        resolve(oAuth2Client);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(3001, () => {
      console.log('Waiting for OAuth callback on http://localhost:3001/oauth2callback ...');
    });

    server.on('error', reject);
  });
}

function colValue(col, inv) {
  switch (col) {
    case 'ksefNumber':              return inv.ksefReferenceNumber || inv.ksefNumber || '';
    case 'invoiceNumber':           return inv.invoiceNumber || '';
    case 'issueDate':               return inv.issueDate || '';
    case 'invoicingDate':           return inv.invoicingDate || '';
    case 'acquisitionDate':         return inv.acquisitionDate ? inv.acquisitionDate.split('T')[0] : '';
    case 'permanentStorageDate':    return inv.permanentStorageDate ? inv.permanentStorageDate.split('T')[0] : '';
    case 'sellerNip':               return inv.seller?.nip || '';
    case 'sellerName':              return inv.seller?.name || '';
    case 'buyerIdentifierType':     return inv.buyer?.identifier?.type || '';
    case 'buyerIdentifierValue':    return inv.buyer?.identifier?.value || '';
    case 'buyerName':               return inv.buyer?.name || '';
    case 'netAmount':               return inv.netAmount ?? '';
    case 'grossAmount':             return inv.grossAmount ?? '';
    case 'vatAmount':               return inv.vatAmount ?? '';
    case 'currency':                return inv.currency || '';
    case 'invoicingMode':           return inv.invoicingMode || '';
    case 'invoiceType':             return inv.invoiceType || '';
    case 'formCodeSystemCode':      return inv.formCode?.systemCode || '';
    case 'isSelfInvoicing':         return inv.isSelfInvoicing ? 'TAK' : 'NIE';
    case 'hasAttachment':           return inv.hasAttachment ? 'TAK' : 'NIE';
    // extra sale columns
    case 'dueDatePlaceholder':        return inv._dueDate || '';
    case 'paymentDatePlaceholder':    return '';
    case 'paymentStatusPlaceholder':  return inv._paymentStatus || '';
    case 'paymentMethodPlaceholder':  return inv._payForm || '';
    case 'isCorrectiveInvoice':       return inv.invoiceType?.toUpperCase() === 'KOR' ? 'TAK' : '';
    case 'driveLink':                 return inv._driveLink || '';
    case 'correctiveDriveLink':       return inv._correctiveDriveLink || '';
    default:                        return '';
  }
}

function invoiceToRow(inv, extraColumns, baseCols) {
  const base = baseCols || COLUMNS;
  const cols = extraColumns ? [...extraColumns, ...base] : base;
  return cols.map((col) => colValue(col, inv));
}

async function ensureSheet(sheets, sheetTitle) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = meta.data.sheets.find((s) => s.properties.title === sheetTitle);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: sheetTitle } } }],
    },
  });
}

async function writeInvoicesToSheet(auth, invoices, sheetTitle, extraColumns, extraHeaders, baseCols, baseHdrs) {
  if (!invoices.length) {
    console.log(`Sheets: no invoices for "${sheetTitle}", skipping`);
    return;
  }

  const sheets = google.sheets({ version: 'v4', auth });
  await ensureSheet(sheets, sheetTitle);

  // Read all existing data to check for duplicates and header presence
  const existingData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetTitle}'`,
  });
  const existingRows = existingData.data.values || [];
  const hasHeader = existingRows.length > 0;

  // Find which column index holds the KSeF number in the written rows
  const allCols = extraColumns ? [...extraColumns, ...(baseCols || COLUMNS)] : (baseCols || COLUMNS);
  const ksefColIndex = allCols.indexOf('ksefNumber');

  // Collect existing KSeF numbers (skip header row)
  const existingKsefNums = new Set();
  if (hasHeader && ksefColIndex >= 0) {
    for (let i = 1; i < existingRows.length; i++) {
      const val = existingRows[i][ksefColIndex];
      if (val) existingKsefNums.add(val);
    }
  }

  // Filter out already-present invoices
  const newInvoices = invoices.filter(inv => {
    const ksefNum = inv.ksefReferenceNumber || inv.ksefNumber || '';
    return !existingKsefNums.has(ksefNum);
  });

  if (!newInvoices.length) {
    console.log(`Sheets: all ${invoices.length} invoices already present in "${sheetTitle}", skipping`);
    return;
  }

  const usedHdrs = baseHdrs || HEADERS;
  const headers = extraHeaders ? [...extraHeaders, ...usedHdrs] : usedHdrs;
  const dataRows = newInvoices.map((inv) => invoiceToRow(inv, extraColumns, baseCols));
  const rows = hasHeader ? dataRows : [headers, ...dataRows];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${sheetTitle}'!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });

  console.log(`Sheets: appended ${newInvoices.length} new rows to "${sheetTitle}" (${invoices.length - newInvoices.length} duplicates skipped)`);
}

async function syncToSheets(outgoing, incoming, auth) {
  if (!auth) auth = await authorize();
  await Promise.all([
    writeInvoicesToSheet(auth, outgoing, 'Sprzedaż (Subject1)', EXTRA_SALE_COLUMNS, EXTRA_SALE_HEADERS, COLUMNS_SALE, HEADERS_SALE),
    writeInvoicesToSheet(auth, incoming, 'Zakupy (Subject2)', EXTRA_PURCHASE_COLUMNS, EXTRA_PURCHASE_HEADERS, COLUMNS_PURCHASE, HEADERS_PURCHASE),
  ]);
}

async function writeOutgoing(auth, invoices) {
  return writeInvoicesToSheet(auth, invoices, 'Sprzedaż (Subject1)', EXTRA_SALE_COLUMNS, EXTRA_SALE_HEADERS, COLUMNS_SALE, HEADERS_SALE);
}

async function writeIncoming(auth, invoices) {
  return writeInvoicesToSheet(auth, invoices, 'Zakupy (Subject2)', EXTRA_PURCHASE_COLUMNS, EXTRA_PURCHASE_HEADERS, COLUMNS_PURCHASE, HEADERS_PURCHASE);
}

async function getExistingKsefNums(auth, sheetTitle, allCols) {
  const sheets = google.sheets({ version: 'v4', auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  if (!meta.data.sheets.find(s => s.properties.title === sheetTitle)) return new Set();

  const data = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetTitle}'`,
  });
  const rows = data.data.values || [];
  const ksefIdx = allCols.indexOf('ksefNumber');
  if (ksefIdx < 0 || rows.length <= 1) return new Set();

  const result = new Set();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][ksefIdx]) result.add(rows[i][ksefIdx]);
  }
  return result;
}

async function getExistingOutgoing(auth) {
  return getExistingKsefNums(auth, 'Sprzedaż (Subject1)', [...EXTRA_SALE_COLUMNS, ...COLUMNS_SALE]);
}

async function getExistingIncoming(auth) {
  return getExistingKsefNums(auth, 'Zakupy (Subject2)', [...EXTRA_PURCHASE_COLUMNS, ...COLUMNS_PURCHASE]);
}

async function updateCorrectiveDriveLink(auth, originalKsefNum, driveLink) {
  const sheetTitle = 'Zakupy (Subject2)';
  const allCols = [...EXTRA_PURCHASE_COLUMNS, ...COLUMNS_PURCHASE];
  const ksefIdx = allCols.indexOf('ksefNumber');
  const linkIdx = allCols.indexOf('correctiveDriveLink');

  const sheets = google.sheets({ version: 'v4', auth });
  const data = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${sheetTitle}'`,
  });
  const rows = data.data.values || [];

  for (let i = 1; i < rows.length; i++) {
    if (rows[i][ksefIdx] !== originalKsefNum) continue;
    if (rows[i][linkIdx]) return false; // already set
    const col = String.fromCharCode(65 + linkIdx);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${sheetTitle}'!${col}${i + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[driveLink]] },
    });
    return true;
  }
  return null; // original row not found
}

module.exports = { authorize, syncToSheets, writeOutgoing, writeIncoming, getExistingOutgoing, getExistingIncoming, updateCorrectiveDriveLink };
