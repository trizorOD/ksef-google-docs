// Manual, isolated test of the email reminder flow.
//
// Sends real emails via the SMTP configured in .env, using entirely
// made-up invoice rows and a made-up Contacts map — never reads or
// writes the real Google Sheet, so it is safe to run against production
// SMTP credentials without touching real invoice/client data.
//
// Usage:
//   node manual_test_reminders.js your@email.com
//
// Sends three test emails to the given address: one "reminder" (due
// tomorrow), one "overdue" (due date yesterday), and one "final notice"
// (due date well in the past). No PDF attachment (no real KSeF number to
// look up in Drive) — the inline logo is still attached, so this is enough
// to eyeball the HTML rendering.

const { runReminders } = require('./reminders');
const { warsawTodayISO, addDaysISO } = require('./template_utils');

const targetEmail = process.argv[2];
if (!targetEmail) {
  console.error('Usage: node manual_test_reminders.js your@email.com');
  process.exit(1);
}

const today = warsawTodayISO();
const tomorrow = addDaysISO(today, 1);
const yesterday = addDaysISO(today, -1);
const wellPastDue = addDaysISO(today, -10);

const fakeRows = [
  {
    rowNumber: -1, // never used for real — the mocks below just log
    invoiceNumber: 'TEST-REMINDER-001',
    buyerName: 'Manual Test Buyer',
    issueDate: today,
    dueDate: tomorrow,
    grossAmount: 123.45,
    status: 'не оплачено',
    ksefNumber: '',
    reminderSent: '',
    overdueSent: '',
    finalNoticeSent: '',
  },
  {
    rowNumber: -2,
    invoiceNumber: 'TEST-OVERDUE-001',
    buyerName: 'Manual Test Buyer',
    issueDate: '2026-08-01',
    dueDate: yesterday,
    grossAmount: 500,
    status: 'не оплачено',
    ksefNumber: '',
    reminderSent: '',
    overdueSent: '',
    finalNoticeSent: '',
  },
  {
    rowNumber: -3,
    invoiceNumber: 'TEST-FINAL-001',
    buyerName: 'Manual Test Buyer',
    issueDate: '2026-08-01',
    dueDate: wellPastDue,
    grossAmount: 999.99,
    status: 'не оплачено',
    ksefNumber: '',
    reminderSent: '',
    overdueSent: '',
    finalNoticeSent: '',
  },
];

const fakeContacts = new Map([['manual test buyer', targetEmail]]);

// Every Sheets call is mocked — nothing here ever touches the real
// spreadsheet, read or write.
const fakeSheets = {
  ensureSaleHeaderColumns: async () => {},
  getSaleRowsForReminders: async () => fakeRows,
  getContacts: async () => fakeContacts,
  markReminderSent: async (_auth, rowNumber, date) => {
    console.log(`[mock] would mark row ${rowNumber} Reminder sent = ${date}`);
  },
  markOverdueSent: async (_auth, rowNumber, date) => {
    console.log(`[mock] would mark row ${rowNumber} Overdue email sent = ${date}`);
  },
  markFinalNoticeSent: async (_auth, rowNumber, date) => {
    console.log(`[mock] would mark row ${rowNumber} Final notice sent = ${date}`);
  },
};

(async () => {
  console.log(`Sending test reminder + overdue + final notice emails to ${targetEmail} (today=${today})...\n`);
  const summary = await runReminders(null, {
    todayISO: today,
    log: (msg) => console.log(msg),
    sheets: fakeSheets,
  });
  console.log('\nSummary:', summary);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
