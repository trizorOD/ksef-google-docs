const express = require('express');
const path = require('path');
const xml2js = require('xml2js');
const cron = require('node-cron');
const config = require('./config');
const { createSession, invoiceMetadataPages, downloadInvoiceXml } = require('./ksef_client');
const { authorize, writeOutgoing, writeIncoming, getExistingOutgoing, getExistingIncoming, updateCorrectiveDriveLink } = require('./sheets_client');
const { uploadPdf } = require('./drive_client');
const { parseInvoice, generatePdf } = require('./pdf_generator');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let syncState = { running: false, log: [], lastRun: null, error: null };

function addLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  syncState.log.push(line);
  if (syncState.log.length > 500) syncState.log.shift();
}

async function enrichWithPdfs(invoices, ksefClient, auth, label) {
  let done = 0;
  for (const inv of invoices) {
    const ksefNum = inv.ksefReferenceNumber || inv.ksefNumber;
    if (!ksefNum) {
      addLog(`${label}: WARNING — no KSeF number on invoice ${inv.invoiceNumber}, skipping PDF`);
      continue;
    }
    try {
      const xml = await downloadInvoiceXml(ksefClient, ksefNum);
      const parsed = await xml2js.parseStringPromise(xml, { tagNameProcessors: [xml2js.processors.stripPrefix] });
      const data = parseInvoice(parsed);

      if (data.dueDate)    inv._dueDate = data.dueDate;
      if (data.payForm)    inv._payForm = data.payForm;
      if (data.isPaid)     inv._paymentStatus = 'Paid';

      const pdfBuffer = await generatePdf(data, ksefNum);
      inv._driveLink = await uploadPdf(auth, pdfBuffer, `${ksefNum}.pdf`);

      done++;
      addLog(`${label}: PDF uploaded ${done}/${invoices.length} — ${inv.invoiceNumber}`);
    } catch (err) {
      addLog(`${label}: PDF failed for ${ksefNum} — ${err.message}`);
      console.error(err);
    }
  }
}

const SKIP_BUYERS = ['t-mobile', 'frisco', 'culligan', 'ls coffee'];

function getKsefNum(inv) {
  return inv.ksefReferenceNumber || inv.ksefNumber || '';
}

async function runSync(fromDate, toDate) {
  addLog(`Sync started: ${fromDate} → ${toDate}`);

  const ksefClient = await createSession();
  const auth = await authorize();
  addLog('Authenticated with KSeF and Google');

  const existingOut = await getExistingOutgoing(auth);
  const existingIn = await getExistingIncoming(auth);
  addLog(`Already in sheets: ${existingOut.size} outgoing, ${existingIn.size} incoming`);

  // Subject1 — outgoing (Sprzedaż)
  addLog('Fetching outgoing invoices (Subject1)...');
  const outgoing = [];
  for await (const page of invoiceMetadataPages(ksefClient, 'Subject1', fromDate, toDate)) {
    for (const inv of page) {
      if (existingOut.has(getKsefNum(inv))) continue;
      if (inv.invoiceType?.toUpperCase() === 'KOR') {
        addLog(`Outgoing: skipping corrective invoice ${inv.invoiceNumber}`);
        continue;
      }
      if (String(inv.invoiceNumber || '').startsWith('0')) {
        addLog(`Outgoing: skipping ${inv.invoiceNumber} (starts with 0)`);
        continue;
      }
      outgoing.push(inv);
    }
  }
  addLog(`Outgoing: ${outgoing.length} new invoice(s) to process`);
  if (outgoing.length > 0) {
    await enrichWithPdfs(outgoing, ksefClient, auth, 'Outgoing');
    await writeOutgoing(auth, outgoing);
    addLog('Outgoing: written to sheet');
  }

  // Subject2 — incoming (Zakupy)
  addLog('Fetching incoming invoices (Subject2)...');
  const incoming = [];
  const incomingCorrective = [];
  for await (const page of invoiceMetadataPages(ksefClient, 'Subject2', fromDate, toDate)) {
    for (const inv of page) {
      if (existingIn.has(getKsefNum(inv))) continue;
      const sellerName = String(inv.seller?.name || '').toLowerCase();
      const matched = SKIP_BUYERS.find(b => sellerName.includes(b));
      if (matched) {
        addLog(`Incoming: skipping ${inv.invoiceNumber} (seller: ${inv.seller?.name})`);
        continue;
      }
      if (inv.invoiceType?.toUpperCase() === 'KOR') {
        incomingCorrective.push(inv);
      } else {
        incoming.push(inv);
      }
    }
  }
  addLog(`Incoming: ${incoming.length} new invoice(s), ${incomingCorrective.length} corrective(s)`);
  if (incoming.length > 0) {
    await enrichWithPdfs(incoming, ksefClient, auth, 'Incoming');
    await writeIncoming(auth, incoming);
    addLog('Incoming: written to sheet');
  }

  // Corrective invoices — attach PDF link to the original row
  for (const inv of incomingCorrective) {
    const ksefNum = getKsefNum(inv);
    if (!ksefNum) continue;
    try {
      const xml = await downloadInvoiceXml(ksefClient, ksefNum);
      const parsed = await xml2js.parseStringPromise(xml, { tagNameProcessors: [xml2js.processors.stripPrefix] });
      const data = parseInvoice(parsed);
      const originalKsefNum = data.originalKsefNumber;
      if (!originalKsefNum) {
        addLog(`Incoming corrective: no original KSeF ref in ${inv.invoiceNumber}, skipping`);
        continue;
      }
      const pdfBuffer = await generatePdf(data, ksefNum);
      const driveLink = await uploadPdf(auth, pdfBuffer, `${ksefNum}.pdf`);
      const result = await updateCorrectiveDriveLink(auth, originalKsefNum, driveLink);
      if (result === true)  addLog(`Incoming corrective: attached ${inv.invoiceNumber} → ${originalKsefNum}`);
      if (result === false) addLog(`Incoming corrective: ${inv.invoiceNumber} already attached, skipping`);
      if (result === null)  addLog(`Incoming corrective: original ${originalKsefNum} not in sheet yet (${inv.invoiceNumber})`);
    } catch (err) {
      addLog(`Incoming corrective: failed for ${ksefNum} — ${err.message}`);
      console.error(err);
    }
  }

  syncState.lastRun = new Date().toISOString();
  addLog('Sync completed successfully');
}

// POST /api/sync  { fromDate, toDate }
app.post('/api/sync', async (req, res) => {
  if (syncState.running) {
    return res.status(409).json({ error: 'Sync already running' });
  }

  const fromDate = (req.body.fromDate || config.sync.startDate).slice(0, 10) + 'T00:00:00';
  const toDate = ((req.body.toDate || '').slice(0, 10) || new Date().toISOString().slice(0, 10)) + 'T23:59:59';

  syncState.running = true;
  syncState.error = null;
  syncState.log = [];

  res.json({ status: 'started', fromDate, toDate });

  (async () => {
    try {
      await runSync(fromDate, toDate);
    } catch (err) {
      syncState.error = err.message;
      addLog(`ERROR: ${err.message}`);
      if (err.response) {
        addLog(`HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
      }
    } finally {
      syncState.running = false;
    }
  })();
});

// GET /api/sync/status
app.get('/api/sync/status', (_req, res) => {
  res.json(syncState);
});

app.listen(config.port, () => {
  console.log(`Server running at http://localhost:${config.port}`);
});

// Daily sync at 11:00 Warsaw time — fetches yesterday + today
cron.schedule('0 11 * * *', async () => {
  if (syncState.running) {
    console.log('[CRON] Sync already running, skipping scheduled run');
    return;
  }

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const fromDate = `${yesterday.toISOString().slice(0, 10)}T00:00:00`;
  const toDate = `${today.toISOString().slice(0, 10)}T23:59:59`;

  syncState.running = true;
  syncState.error = null;
  syncState.log = [];

  try {
    await runSync(fromDate, toDate);
  } catch (err) {
    syncState.error = err.message;
    addLog(`[CRON] ERROR: ${err.message}`);
    if (err.response) {
      addLog(`HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
  } finally {
    syncState.running = false;
  }
}, { timezone: 'Europe/Warsaw' });
