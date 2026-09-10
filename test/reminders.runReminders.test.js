const test = require('node:test');
const assert = require('node:assert/strict');
const { runReminders } = require('../reminders');

const TODAY = '2026-09-10';
const AUTH = { fake: 'auth' };

function saleRow(overrides = {}) {
  return {
    rowNumber: 7,
    invoiceNumber: 'FV/1/2026',
    buyerName: 'Acme Sp. z o.o.',
    issueDate: '2026-09-01',
    dueDate: '2026-09-11', // tomorrow relative to TODAY -> reminder
    grossAmount: 1230.5,
    status: '',
    reminderSent: '',
    overdueSent: '',
    ...overrides,
  };
}

// Builds a fake sheets object plus per-function call recorders.
function makeSheets({ rows = [], contacts = new Map(), markReminderSent, markOverdueSent } = {}) {
  const calls = { ensureSaleHeaderColumns: [], markReminderSent: [], markOverdueSent: [] };
  const sheets = {
    ensureSaleHeaderColumns: async (...args) => { calls.ensureSaleHeaderColumns.push(args); },
    getSaleRowsForReminders: async () => rows,
    getContacts: async () => contacts,
    markReminderSent: async (...args) => {
      calls.markReminderSent.push(args);
      if (markReminderSent) return markReminderSent(...args);
      return undefined;
    },
    markOverdueSent: async (...args) => {
      calls.markOverdueSent.push(args);
      if (markOverdueSent) return markOverdueSent(...args);
      return undefined;
    },
  };
  return { sheets, calls };
}

function makeTransporter({ fail } = {}) {
  const calls = [];
  const transporter = {
    sendMail: async (message) => {
      calls.push(message);
      if (fail) throw new Error('SMTP down');
      return { messageId: 'x' };
    },
  };
  return { transporter, calls };
}

const contactsFor = (name, email) => new Map([[name.trim().toLowerCase(), email]]);

test('runReminders sends a reminder email and records it on the row', async () => {
  const row = saleRow();
  const { sheets, calls } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
  });
  const { transporter, calls: sent } = makeTransporter();

  const summary = await runReminders(AUTH, { todayISO: TODAY, transporter, sheets });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'billing@acme.pl');
  assert.match(sent[0].subject, /FV\/1\/2026/);
  assert.match(sent[0].text, /FV\/1\/2026/);
  assert.deepEqual(calls.markReminderSent, [[AUTH, 7, '10-09-2026']]);
  assert.equal(calls.markOverdueSent.length, 0);
  assert.deepEqual(summary, {
    sentReminder: 1, sentOverdue: 0, skippedNoContact: 0, skippedNotAllowlisted: 0, failed: 0, failedToRecord: 0,
  });
});

test('runReminders sends an overdue email and records it on the row', async () => {
  const row = saleRow({ dueDate: '2026-09-01' }); // past due -> overdue
  const { sheets, calls } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
  });
  const { transporter, calls: sent } = makeTransporter();

  const summary = await runReminders(AUTH, { todayISO: TODAY, transporter, sheets });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'billing@acme.pl');
  assert.match(sent[0].subject, /FV\/1\/2026/);
  assert.deepEqual(calls.markOverdueSent, [[AUTH, 7, '10-09-2026']]);
  assert.equal(calls.markReminderSent.length, 0);
  assert.deepEqual(summary, {
    sentReminder: 0, sentOverdue: 1, skippedNoContact: 0, skippedNotAllowlisted: 0, failed: 0, failedToRecord: 0,
  });
});

test('runReminders skips a row with no matching Contacts email', async () => {
  const row = saleRow();
  const { sheets, calls } = makeSheets({ rows: [row], contacts: new Map() });
  const { transporter, calls: sent } = makeTransporter();

  const summary = await runReminders(AUTH, { todayISO: TODAY, transporter, sheets });

  assert.equal(sent.length, 0);
  assert.equal(calls.markReminderSent.length, 0);
  assert.equal(calls.markOverdueSent.length, 0);
  assert.equal(summary.skippedNoContact, 1);
  assert.equal(summary.sentReminder, 0);
  assert.equal(summary.sentOverdue, 0);
  assert.equal(summary.failed, 0);
});

test('runReminders never marks a row sent when the send itself fails', async () => {
  const row = saleRow();
  const { sheets, calls } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
  });
  const { transporter, calls: sent } = makeTransporter({ fail: true });
  const lines = [];

  const summary = await runReminders(AUTH, {
    todayISO: TODAY, transporter, sheets, log: (l) => lines.push(l),
  });

  assert.equal(sent.length, 1);
  assert.equal(calls.markReminderSent.length, 0, 'a failed send must not mark the row');
  assert.equal(calls.markOverdueSent.length, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.sentReminder, 0);
  assert.equal(summary.failedToRecord, 0);
  assert.ok(lines.some((l) => l.includes('Failed to send reminder email for FV/1/2026')));
});

test('runReminders counts a sent email whose sheet write fails as sent-but-not-recorded', async () => {
  const row = saleRow();
  const { sheets, calls } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
    markReminderSent: () => { throw new Error('Sheets quota exceeded'); },
  });
  const { transporter, calls: sent } = makeTransporter();
  const lines = [];

  const summary = await runReminders(AUTH, {
    todayISO: TODAY, transporter, sheets, log: (l) => lines.push(l),
  });

  assert.equal(sent.length, 1);
  assert.equal(calls.markReminderSent.length, 1);
  assert.equal(summary.sentReminder, 1, 'the email really was sent');
  assert.equal(summary.failedToRecord, 1);
  assert.equal(summary.failed, 0);
  assert.ok(lines.some((l) => l.includes('WARNING') && l.includes('FV/1/2026')));
});

test('runReminders counts an overdue email whose sheet write fails as sent-but-not-recorded', async () => {
  const row = saleRow({ dueDate: '2026-09-01' });
  const { sheets, calls } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
    markOverdueSent: () => { throw new Error('Sheets quota exceeded'); },
  });
  const { transporter, calls: sent } = makeTransporter();
  const lines = [];

  const summary = await runReminders(AUTH, {
    todayISO: TODAY, transporter, sheets, log: (l) => lines.push(l),
  });

  assert.equal(sent.length, 1);
  assert.equal(calls.markOverdueSent.length, 1);
  assert.equal(summary.sentOverdue, 1);
  assert.equal(summary.failedToRecord, 1);
  assert.ok(lines.some((l) => l.includes('WARNING')));
});

test('runReminders skips rows that need no action', async () => {
  const rows = [
    saleRow({ invoiceNumber: 'FV/2/2026', dueDate: '2026-09-20' }), // not due yet
    saleRow({ invoiceNumber: 'FV/3/2026', dueDate: '2026-09-01', status: 'Paid' }), // paid
    saleRow({ invoiceNumber: 'FV/4/2026', dueDate: '2026-09-11', reminderSent: '10-09-2026' }),
    saleRow({ invoiceNumber: 'FV/5/2026', dueDate: '2026-09-01', overdueSent: '05-09-2026' }),
    saleRow({ invoiceNumber: 'FV/6/2026', dueDate: '' }), // no due date
  ];
  const { sheets, calls } = makeSheets({
    rows,
    contacts: contactsFor('Acme Sp. z o.o.', 'billing@acme.pl'),
  });
  const { transporter, calls: sent } = makeTransporter();

  const summary = await runReminders(AUTH, { todayISO: TODAY, transporter, sheets });

  assert.equal(sent.length, 0);
  assert.equal(calls.markReminderSent.length, 0);
  assert.equal(calls.markOverdueSent.length, 0);
  assert.deepEqual(summary, {
    sentReminder: 0, sentOverdue: 0, skippedNoContact: 0, skippedNotAllowlisted: 0, failed: 0, failedToRecord: 0,
  });
});

test('runReminders with a testOnlyRecipients allowlist only sends to listed addresses', async () => {
  const rowToFriend = saleRow({ invoiceNumber: 'FV/1/2026', buyerName: 'Acme Sp. z o.o.' });
  const rowToSelf = saleRow({ invoiceNumber: 'FV/2/2026', buyerName: 'Self Test Buyer' });
  const contacts = new Map([
    ['acme sp. z o.o.', 'billing@acme.pl'],
    ['self test buyer', 'me@example.com'],
  ]);
  const { sheets, calls } = makeSheets({ rows: [rowToFriend, rowToSelf], contacts });
  const { transporter, calls: sent } = makeTransporter();
  const lines = [];

  const summary = await runReminders(AUTH, {
    todayISO: TODAY, transporter, sheets, log: (l) => lines.push(l),
    testOnlyRecipients: ['me@example.com'],
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'me@example.com');
  assert.equal(calls.markReminderSent.length, 1);
  assert.equal(summary.sentReminder, 1);
  assert.equal(summary.skippedNotAllowlisted, 1);
  assert.ok(lines.some((l) => l.includes('TEST MODE')));
  assert.ok(lines.some((l) => l.includes('FV/1/2026') && l.includes('not in the test allowlist')));
});

test('runReminders ensures the tracking header columns exist before reading rows', async () => {
  const { sheets, calls } = makeSheets({ rows: [], contacts: new Map() });
  const { transporter } = makeTransporter();

  await runReminders(AUTH, { todayISO: TODAY, transporter, sheets });

  assert.deepEqual(calls.ensureSaleHeaderColumns, [[AUTH]]);
});
