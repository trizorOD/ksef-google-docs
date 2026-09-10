const path = require('path');
const {
  loadTemplate, renderTemplate, formatAmountPl, formatDatePl, parseDatePl, addDaysISO, warsawTodayISO,
} = require('./template_utils');

const REMINDER_TEMPLATE_PATH = path.join(__dirname, 'templates', 'reminder.txt');
const OVERDUE_TEMPLATE_PATH = path.join(__dirname, 'templates', 'overdue.txt');

// How often to re-send the overdue notice while an invoice remains unpaid.
const OVERDUE_FOLLOWUP_DAYS = 7;

function isPaidStatus(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return normalized === 'paid' || normalized === 'оплачено';
}

function needsReminder(row, todayISO) {
  return !!row.dueDate && !row.reminderSent && row.dueDate === addDaysISO(todayISO, 1);
}

function needsOverdue(row, todayISO) {
  if (!row.dueDate || row.dueDate >= todayISO) return false;
  if (!row.overdueSent) return true; // first overdue notice for this invoice

  // Already sent at least once — re-send every OVERDUE_FOLLOWUP_DAYS while
  // still unpaid. If the previous send date can't be parsed, don't guess:
  // treat it as "already handled" rather than risk a spam loop.
  const lastSentISO = parseDatePl(row.overdueSent);
  if (!lastSentISO) return false;
  return addDaysISO(lastSentISO, OVERDUE_FOLLOWUP_DAYS) <= todayISO;
}

function decideAction(row, todayISO) {
  if (!row.invoiceNumber || !row.dueDate) return null;
  if (isPaidStatus(row.status)) return null;
  if (needsReminder(row, todayISO)) return 'reminder';
  if (needsOverdue(row, todayISO)) return 'overdue';
  return null;
}

function buildEmail(action, row) {
  const templatePath = action === 'reminder' ? REMINDER_TEMPLATE_PATH : OVERDUE_TEMPLATE_PATH;
  const template = loadTemplate(templatePath);
  const vars = {
    NUMER: row.invoiceNumber,
    KWOTA: formatAmountPl(row.grossAmount),
    DATA: formatDatePl(row.issueDate),
    'TERMIN PŁATNOŚCI': formatDatePl(row.dueDate),
  };
  return renderTemplate(template, vars);
}

const nodemailer = require('nodemailer');
const config = require('./config');
const {
  ensureSaleHeaderColumns, getSaleRowsForReminders, getContacts,
  markReminderSent, markOverdueSent,
} = require('./sheets_client');

function createTransport() {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
}

async function runReminders(auth, options = {}) {
  const log = options.log || (() => {});
  const todayISO = options.todayISO || warsawTodayISO();
  const transporter = options.transporter || createTransport();
  const sheets = {
    ensureSaleHeaderColumns,
    getSaleRowsForReminders,
    getContacts,
    markReminderSent,
    markOverdueSent,
    ...options.sheets,
  };

  log(`Reminder run started for ${todayISO}`);

  await sheets.ensureSaleHeaderColumns(auth);
  const rows = await sheets.getSaleRowsForReminders(auth);
  const contacts = await sheets.getContacts(auth);

  const summary = {
    sentReminder: 0, sentOverdue: 0, skippedNoContact: 0, skippedNotAllowlisted: 0, failed: 0, failedToRecord: 0,
  };

  const allowlist = options.testOnlyRecipients || config.smtp.testOnlyRecipients;
  if (allowlist.length) {
    log(`TEST MODE: only sending to allowlisted recipient(s): ${allowlist.join(', ')} — everything else will be skipped`);
  }

  for (const row of rows) {
    const action = decideAction(row, todayISO);
    if (!action) continue;

    const email = contacts.get(row.buyerName.trim().toLowerCase());
    if (!email) {
      log(`Skipping ${row.invoiceNumber}: no Contacts email for buyer "${row.buyerName}"`);
      summary.skippedNoContact++;
      continue;
    }

    if (allowlist.length && !allowlist.includes(email.trim().toLowerCase())) {
      log(`Skipping ${row.invoiceNumber}: recipient ${email} not in the test allowlist`);
      summary.skippedNotAllowlisted++;
      continue;
    }

    const rendered = buildEmail(action, row);

    try {
      await transporter.sendMail({
        from: config.smtp.from,
        to: email,
        subject: rendered.subject,
        text: rendered.body,
      });
    } catch (err) {
      summary.failed++;
      log(`Failed to send ${action} email for ${row.invoiceNumber}: ${err.message}`);
      continue;
    }

    if (action === 'reminder') summary.sentReminder++; else summary.sentOverdue++;
    log(`Sent ${action} email for ${row.invoiceNumber} to ${email}`);

    try {
      const sentDate = formatDatePl(todayISO);
      if (action === 'reminder') {
        await sheets.markReminderSent(auth, row.rowNumber, sentDate);
      } else {
        await sheets.markOverdueSent(auth, row.rowNumber, sentDate);
      }
    } catch (err) {
      summary.failedToRecord++;
      log(`WARNING: sent ${action} email for ${row.invoiceNumber} to ${email} but failed to record it in the sheet (row ${row.rowNumber}) — a duplicate may be sent next run: ${err.message}`);
    }
  }

  log(`Reminder run completed: ${summary.sentReminder} reminder(s), ${summary.sentOverdue} overdue, ${summary.skippedNoContact} skipped (no contact), ${summary.skippedNotAllowlisted} skipped (not allowlisted), ${summary.failed} failed, ${summary.failedToRecord} sent but not recorded`);
  return summary;
}

module.exports = {
  isPaidStatus, needsReminder, needsOverdue, decideAction, buildEmail,
  createTransport, runReminders,
};
