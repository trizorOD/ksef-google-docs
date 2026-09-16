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
    status: 'не оплачено',
    ksefNumber: '', // most tests don't care about the attachment; set explicitly where they do
    reminderSent: '',
    overdueSent: '',
    finalNoticeSent: '',
    ...overrides,
  };
}

const EMPTY_SUMMARY = {
  sentReminder: 0, sentOverdue: 0, sentFinal: 0, skippedNoContact: 0, skippedNotAllowlisted: 0, failed: 0, failedToRecord: 0,
};

// Builds a fake sheets object plus per-function call recorders.
function makeSheets({
  rows = [], contacts = new Map(), markReminderSent, markOverdueSent, markFinalNoticeSent,
} = {}) {
  const calls = {
    ensureSaleHeaderColumns: [], markReminderSent: [], markOverdueSent: [], markFinalNoticeSent: [],
  };
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
    markFinalNoticeSent: async (...args) => {
      calls.markFinalNoticeSent.push(args);
      if (markFinalNoticeSent) return markFinalNoticeSent(...args);
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

function makeDownloadAttachment({ fail, buffer } = {}) {
  const calls = [];
  const downloadAttachment = async (...args) => {
    calls.push(args);
    if (fail) throw new Error('Drive download failed');
    return buffer || Buffer.from('%PDF-fake');
  };
  return { downloadAttachment, calls };
}

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
  assert.equal(calls.markFinalNoticeSent.length, 0);
  assert.deepEqual(summary, { ...EMPTY_SUMMARY, sentReminder: 1 });
});

test('runReminders sends an overdue email and records it on the row', async () => {
  const row = saleRow({ dueDate: '2026-09-09' }); // 1 day past due -> overdue (not yet final territory)
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
  assert.equal(calls.markFinalNoticeSent.length, 0);
  assert.deepEqual(summary, { ...EMPTY_SUMMARY, sentOverdue: 1 });
});

test('runReminders sends a final notice and records it on the row', async () => {
  const row = saleRow({ dueDate: '2026-09-01', overdueSent: '02-09-2026' }); // 9 days past due, overdue already sent
  const { sheets, calls } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
  });
  const { transporter, calls: sent } = makeTransporter();

  const summary = await runReminders(AUTH, { todayISO: TODAY, transporter, sheets });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'billing@acme.pl');
  assert.match(sent[0].subject, /Ostateczne wezwanie/);
  assert.match(sent[0].text, /FV\/1\/2026/);
  assert.deepEqual(calls.markFinalNoticeSent, [[AUTH, 7, '10-09-2026']]);
  assert.equal(calls.markReminderSent.length, 0);
  assert.equal(calls.markOverdueSent.length, 0);
  assert.deepEqual(summary, { ...EMPTY_SUMMARY, sentFinal: 1 });
});

test('runReminders always attaches the inline logo, cid-referenced for the HTML body', async () => {
  const row = saleRow({ ksefNumber: '' });
  const { sheets } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
  });
  const { transporter, calls: sent } = makeTransporter();

  await runReminders(AUTH, { todayISO: TODAY, transporter, sheets });

  assert.equal(sent[0].attachments.length, 1); // logo only — no ksefNumber, so no PDF
  assert.equal(sent[0].attachments[0].cid, 'logo');
  assert.equal(sent[0].attachments[0].filename, 'logo.png');
  assert.ok(sent[0].html.includes('cid:logo'));
});

test('runReminders attaches the invoice PDF (alongside the logo) when the row has a KSeF number', async () => {
  const row = saleRow({ ksefNumber: 'KSEF-123-ABC' });
  const { sheets } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
  });
  const { transporter, calls: sent } = makeTransporter();
  const { downloadAttachment, calls: downloads } = makeDownloadAttachment({ buffer: Buffer.from('%PDF-1.4 fake') });

  const summary = await runReminders(AUTH, { todayISO: TODAY, transporter, sheets, downloadAttachment });

  assert.equal(downloads.length, 1);
  assert.deepEqual(downloads[0], [AUTH, `${row.ksefNumber}.pdf`]);
  assert.equal(sent[0].attachments.length, 2);
  assert.equal(sent[0].attachments[0].cid, 'logo');
  const pdfAttachment = sent[0].attachments.find((a) => a.cid !== 'logo');
  assert.equal(pdfAttachment.filename, 'FV_1_2026.pdf');
  assert.deepEqual(pdfAttachment.content, Buffer.from('%PDF-1.4 fake'));
  assert.equal(summary.sentReminder, 1);
});

test('runReminders sends without a PDF attachment (and logs why) when the row has no KSeF number', async () => {
  const row = saleRow({ ksefNumber: '' });
  const { sheets } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
  });
  const { transporter, calls: sent } = makeTransporter();
  const lines = [];

  await runReminders(AUTH, { todayISO: TODAY, transporter, sheets, log: (l) => lines.push(l) });

  assert.equal(sent[0].attachments.length, 1); // logo only
  assert.ok(lines.some((l) => l.includes('No KSeF number on file for FV/1/2026')));
});

test('runReminders still sends the email (without a PDF attachment, with a warning) when the PDF download fails', async () => {
  const row = saleRow({ ksefNumber: 'KSEF-123-ABC' });
  const { sheets } = makeSheets({
    rows: [row],
    contacts: contactsFor(row.buyerName, 'billing@acme.pl'),
  });
  const { transporter, calls: sent } = makeTransporter();
  const { downloadAttachment } = makeDownloadAttachment({ fail: true });
  const lines = [];

  const summary = await runReminders(AUTH, {
    todayISO: TODAY, transporter, sheets, downloadAttachment, log: (l) => lines.push(l),
  });

  assert.equal(sent.length, 1, 'the email still goes out even though the attachment failed');
  assert.equal(sent[0].attachments.length, 1); // logo only, no PDF
  assert.equal(summary.sentReminder, 1);
  assert.equal(summary.failed, 0);
  assert.ok(lines.some((l) => l.includes('WARNING') && l.includes('could not attach PDF for FV/1/2026')));
});

test('runReminders skips a row with no matching Contacts email', async () => {
  const row = saleRow();
  const { sheets, calls } = makeSheets({ rows: [row], contacts: new Map() });
  const { transporter, calls: sent } = makeTransporter();

  const summary = await runReminders(AUTH, { todayISO: TODAY, transporter, sheets });

  assert.equal(sent.length, 0);
  assert.equal(calls.markReminderSent.length, 0);
  assert.equal(calls.markOverdueSent.length, 0);
  assert.equal(calls.markFinalNoticeSent.length, 0);
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
  assert.equal(calls.markFinalNoticeSent.length, 0);
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
  const row = saleRow({ dueDate: '2026-09-09' });
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
    // overdue already sent, not yet 7 days past due -> no action (not "final" territory yet)
    saleRow({ invoiceNumber: 'FV/5/2026', dueDate: '2026-09-04', overdueSent: '05-09-2026' }),
    saleRow({ invoiceNumber: 'FV/6/2026', dueDate: '' }), // no due date
    saleRow({ invoiceNumber: 'FV/7/2026', dueDate: '2026-09-01', status: 'Cancelled' }), // cancelled
    saleRow({ invoiceNumber: 'FV/8/2026', dueDate: '2026-09-01', status: '' }), // status not yet set
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
  assert.equal(calls.markFinalNoticeSent.length, 0);
  assert.deepEqual(summary, EMPTY_SUMMARY);
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
