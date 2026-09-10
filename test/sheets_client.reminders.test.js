const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSaleRowsForReminders,
  parseContactsRows,
  computeMissingHeaders,
} = require('../sheets_client');

// Column order for Sprzedaż (A..Q) after the schema change:
// Invoice, Buyer, Issue date, Date added to KSeF, Due date, Date of payment,
// Sum, Status of payment, '', Corrective invoice, Link to invoice,
// Numer KSeF, Kwota netto, Kwota brutto, Kwota VAT, Reminder sent, Overdue email sent
function saleRow(overrides = {}) {
  const base = [
    'FV/1/2026', 'Acme Sp. z o.o.', '2026-09-01', '2026-09-01', '2026-09-11',
    '', 1230.5, '', '', '', 'https://drive/x', 'KSEF123', 1000, 1230.5, 230.5, '', '',
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
  const raw = [['Invoice'], saleRow({ 15: '05-09-2026', 16: '' })];
  const rows = parseSaleRowsForReminders(raw);
  assert.equal(rows[0].reminderSent, '05-09-2026');
  assert.equal(rows[0].overdueSent, '');
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
