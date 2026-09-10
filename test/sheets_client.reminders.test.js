const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSaleRowsForReminders,
  parseContactsRows,
  computeMissingHeaders,
  normalizeSheetDate,
  coerceCellText,
} = require('../sheets_client');

// Sheets serial number for 2026-09-11, computed from the 1899-12-30 epoch:
// Math.round((Date.UTC(2026, 8, 11) - Date.UTC(1899, 11, 30)) / 86400000)
const SERIAL_2026_09_11 = 46276;

// Column order for Sprzedaż (A..R) after the schema change:
// Invoice, Buyer, Issue date, Date added to KSeF, Due date, Date of payment,
// Sum, Status of payment, '', Corrective invoice, Link to invoice,
// Numer KSeF, Kwota netto, Kwota brutto, Kwota VAT, Overdue days (user-owned,
// never written), Reminder sent, Overdue email sent
function saleRow(overrides = {}) {
  const base = [
    'FV/1/2026', 'Acme Sp. z o.o.', '2026-09-01', '2026-09-01', '2026-09-11',
    '', 1230.5, '', '', '', 'https://drive/x', 'KSEF123', 1000, 1230.5, 230.5, '', '', '',
  ];
  Object.assign(base, overrides);
  return base;
}

test('parseSaleRowsForReminders maps raw rows to reminder row objects, skipping the header', () => {
  const raw = [['Invoice', 'Buyer'], saleRow()];
  const rows = parseSaleRowsForReminders(raw);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    rowNumber: 2,
    invoiceNumber: 'FV/1/2026',
    buyerName: 'Acme Sp. z o.o.',
    issueDate: '2026-09-01',
    dueDate: '2026-09-11',
    grossAmount: 1230.5,
    status: '',
    reminderSent: '',
    overdueSent: '',
  });
});

test('parseSaleRowsForReminders skips rows with no invoice number', () => {
  const raw = [['Invoice'], saleRow({ 0: '' })];
  assert.equal(parseSaleRowsForReminders(raw).length, 0);
});

test('parseSaleRowsForReminders reads the tracking columns when already sent', () => {
  const raw = [['Invoice'], saleRow({ 16: '05-09-2026', 17: '' })];
  const rows = parseSaleRowsForReminders(raw);
  assert.equal(rows[0].reminderSent, '05-09-2026');
  assert.equal(rows[0].overdueSent, '');
});

test('parseSaleRowsForReminders ignores the Overdue days column (never reads or is affected by its contents)', () => {
  const raw = [['Invoice'], saleRow({ 15: 7 })]; // some formula-computed number the user maintains
  const rows = parseSaleRowsForReminders(raw);
  assert.equal(rows[0].reminderSent, '');
  assert.equal(rows[0].overdueSent, '');
});

test('parseSaleRowsForReminders converts a Sheets date serial number to an ISO date string', () => {
  const raw = [['Invoice'], saleRow({ 4: SERIAL_2026_09_11 })];
  const rows = parseSaleRowsForReminders(raw);
  assert.equal(rows[0].dueDate, '2026-09-11');
  assert.equal(typeof rows[0].dueDate, 'string');
});

test('parseSaleRowsForReminders converts a serial-number issue date too', () => {
  const raw = [['Invoice'], saleRow({ 2: SERIAL_2026_09_11 })];
  assert.equal(parseSaleRowsForReminders(raw)[0].issueDate, '2026-09-11');
});

test('parseSaleRowsForReminders coerces non-string cells to strings without throwing', () => {
  const raw = [['Invoice'], saleRow({ 0: 12345, 1: 678, 7: 0 })];
  const rows = parseSaleRowsForReminders(raw);
  assert.equal(rows[0].invoiceNumber, '12345');
  assert.equal(rows[0].buyerName, '678');
  assert.equal(typeof rows[0].buyerName, 'string');
  // buyerName is later .trim()ed by reminders.js — must not blow up on a number
  assert.doesNotThrow(() => rows[0].buyerName.trim());
  assert.equal(rows[0].status, '0');
});

test('parseSaleRowsForReminders keeps grossAmount numeric', () => {
  const rows = parseSaleRowsForReminders([['Invoice'], saleRow()]);
  assert.equal(rows[0].grossAmount, 1230.5);
  assert.equal(typeof rows[0].grossAmount, 'number');
});

test('normalizeSheetDate converts serial numbers and passes strings through', () => {
  assert.equal(normalizeSheetDate(SERIAL_2026_09_11), '2026-09-11');
  assert.equal(normalizeSheetDate('2026-09-11'), '2026-09-11');
  assert.equal(normalizeSheetDate(''), '');
  assert.equal(normalizeSheetDate(null), '');
  assert.equal(normalizeSheetDate(undefined), '');
});

test('coerceCellText stringifies values and maps blank-ish values to an empty string', () => {
  assert.equal(coerceCellText(SERIAL_2026_09_11), '46276');
  assert.equal(coerceCellText('Acme'), 'Acme');
  assert.equal(coerceCellText(''), '');
  assert.equal(coerceCellText(null), '');
  assert.equal(coerceCellText(undefined), '');
});

test('parseContactsRows builds a lowercase-name to email map, skipping incomplete rows', () => {
  const raw = [
    ['Name', 'Short name', 'NIP', 'Address', 'Email'],
    ['Acme Sp. z o.o.', 'Acme', '1234567890', 'Warszawa', 'billing@acme.pl'],
    ['No Email Sp. z o.o.', '', '', '', ''],
  ];
  const map = parseContactsRows(raw);
  assert.equal(map.get('acme sp. z o.o.'), 'billing@acme.pl');
  assert.equal(map.size, 1);
});

test('computeMissingHeaders returns null when the header already covers all columns', () => {
  const current = Array.from({ length: 17 }, (_, i) => `col${i}`);
  assert.equal(computeMissingHeaders(current, current), null);
});

test('computeMissingHeaders returns the missing trailing labels', () => {
  const current = Array.from({ length: 15 }, (_, i) => `col${i}`);
  const expected = [...current, 'Reminder sent', 'Overdue email sent'];
  const diff = computeMissingHeaders(current, expected);
  assert.deepEqual(diff, { startColIndex: 15, missing: ['Reminder sent', 'Overdue email sent'] });
});

test('computeMissingHeaders appends after a real-world extra manual column ("Overdue days") without touching it', () => {
  // Regression test for a production incident: the live sheet has a
  // 16th column ("Overdue days") that predates this schema and is not
  // managed by this code. The repair must append the two tracking
  // headers starting at column Q (index 16), never touch column P.
  const current = [
    'Invoice', 'Firma', 'Issue date', 'Date added to KSeF', 'Due date',
    'Date of payment', 'Sum', 'Status', '', 'Corrective invoice',
    'Link to invoice', 'Numer KSeF', 'Kwota netto', 'Kwota brutto',
    'Kwota VAT', 'Overdue days',
  ];
  assert.equal(current.length, 16);
  const expected = [...current.slice(0, 15), 'Overdue days', 'Reminder sent', 'Overdue email sent'];
  const diff = computeMissingHeaders(current, expected);
  assert.deepEqual(diff, { startColIndex: 16, missing: ['Reminder sent', 'Overdue email sent'] });
});
