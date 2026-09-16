const path = require('path');
const {
  loadTemplate, loadHtmlBody, renderTemplate, substitutePlaceholders,
  formatAmountPl, formatDatePl, parseDatePl, addDaysISO, warsawTodayISO,
} = require('./template_utils');

const REMINDER_TEMPLATE_PATH = path.join(__dirname, 'templates', 'reminder.txt');
const OVERDUE_TEMPLATE_PATH = path.join(__dirname, 'templates', 'overdue.txt');
const FINAL_NOTICE_TEMPLATE_PATH = path.join(__dirname, 'templates', 'final_notice.txt');

const REMINDER_HTML_PATH = path.join(__dirname, 'templates', 'reminder.html');
const OVERDUE_HTML_PATH = path.join(__dirname, 'templates', 'overdue.html');
const FINAL_NOTICE_HTML_PATH = path.join(__dirname, 'templates', 'final_notice.html');

// Inline-attached (cid:logo) in the HTML body's signature, linking to the
// company site.
const LOGO_PATH = path.join(__dirname, 'templates', 'assets', 'logo.png');

// Days after the due date before the first final notice, and the repeat
// interval for it thereafter while the invoice remains unpaid.
const FINAL_NOTICE_DELAY_DAYS = 7;
const FINAL_NOTICE_REPEAT_DAYS = 7;

// Sending is opt-in, not opt-out: only rows explicitly marked "не оплачено"
// qualify. Blank status, "оплачено"/"Paid", "Cancelled", or anything else
// is skipped — this prevents emailing invoices that were cancelled or
// otherwise never confirmed unpaid (see the production incident where
// Cancelled invoices received overdue notices).
function isUnpaidStatus(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return normalized === 'не оплачено';
}

function needsReminder(row, todayISO) {
  return !!row.dueDate && !row.reminderSent && row.dueDate === addDaysISO(todayISO, 1);
}

// Single-shot: the day-after-due-date notice, sent at most once per
// invoice (with catch-up if a run was missed). From FINAL_NOTICE_DELAY_DAYS
// after the due date onward, needsFinalNotice takes over instead of this
// repeating — see decideAction's priority order below.
function needsOverdue(row, todayISO) {
  return !!row.dueDate && !row.overdueSent && row.dueDate < todayISO;
}

function needsFinalNotice(row, todayISO) {
  if (!row.dueDate) return false;
  if (addDaysISO(row.dueDate, FINAL_NOTICE_DELAY_DAYS) > todayISO) return false;
  if (!row.finalNoticeSent) return true; // first final notice

  // Already sent at least once — re-send every FINAL_NOTICE_REPEAT_DAYS
  // while still unpaid. An unparseable previous-send value is treated as
  // already handled rather than guessed at (same rule as needsOverdue used
  // to follow — see git history — to avoid a spam loop on bad data).
  const lastSentISO = parseDatePl(row.finalNoticeSent);
  if (!lastSentISO) return false;
  return addDaysISO(lastSentISO, FINAL_NOTICE_REPEAT_DAYS) <= todayISO;
}

function decideAction(row, todayISO) {
  if (!row.invoiceNumber || !row.dueDate) return null;
  if (!isUnpaidStatus(row.status)) return null;
  if (needsReminder(row, todayISO)) return 'reminder';
  // Checked before needsOverdue: once the final-notice threshold is
  // reached, escalation wins even on a catch-up run where the day-after
  // notice was never sent (overdueSent stays blank in that case — harmless,
  // since decideAction never reaches needsOverdue once this is true).
  if (needsFinalNotice(row, todayISO)) return 'final';
  if (needsOverdue(row, todayISO)) return 'overdue';
  return null;
}

const TEMPLATE_PATHS = {
  reminder: REMINDER_TEMPLATE_PATH,
  overdue: OVERDUE_TEMPLATE_PATH,
  final: FINAL_NOTICE_TEMPLATE_PATH,
};

const HTML_TEMPLATE_PATHS = {
  reminder: REMINDER_HTML_PATH,
  overdue: OVERDUE_HTML_PATH,
  final: FINAL_NOTICE_HTML_PATH,
};

// Returns { subject, text, html } — subject/text come from the .txt
// template (also the plain-text fallback part of the email), html from the
// matching .html template. Both get the same placeholder substitution.
function buildEmail(action, row) {
  const template = loadTemplate(TEMPLATE_PATHS[action]);
  const htmlBody = loadHtmlBody(HTML_TEMPLATE_PATHS[action]);
  const vars = {
    NUMER: row.invoiceNumber,
    KWOTA: formatAmountPl(row.grossAmount),
    // final_notice's [DATA] reads "termin płatności upłynął [DATA]" — there
    // it means the due date, not the issue date like the other two
    // templates.
    DATA: formatDatePl(action === 'final' ? row.dueDate : row.issueDate),
    'TERMIN PŁATNOŚCI': formatDatePl(row.dueDate),
  };
  const { subject, body: text } = renderTemplate(template, vars);
  const html = substitutePlaceholders(htmlBody, vars);
  return { subject, text, html };
}

const nodemailer = require('nodemailer');
const config = require('./config');
const {
  ensureSaleHeaderColumns, getSaleRowsForReminders, getContacts,
  markReminderSent, markOverdueSent, markFinalNoticeSent,
} = require('./sheets_client');
const { downloadPdfByFilename } = require('./drive_client');

// Sprzedaż invoice numbers can contain '/' (e.g. "FV/2026/665"), unsafe in
// an attachment filename.
function safeAttachmentName(invoiceNumber) {
  return `${invoiceNumber.replace(/[\\/]/g, '_')}.pdf`;
}

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
  const downloadAttachment = options.downloadAttachment || downloadPdfByFilename;
  const sheets = {
    ensureSaleHeaderColumns,
    getSaleRowsForReminders,
    getContacts,
    markReminderSent,
    markOverdueSent,
    markFinalNoticeSent,
    ...options.sheets,
  };

  log(`Reminder run started for ${todayISO}`);

  await sheets.ensureSaleHeaderColumns(auth);
  const rows = await sheets.getSaleRowsForReminders(auth);
  const contacts = await sheets.getContacts(auth);

  const summary = {
    sentReminder: 0, sentOverdue: 0, sentFinal: 0, skippedNoContact: 0, skippedNotAllowlisted: 0, failed: 0, failedToRecord: 0,
  };

  const allowlist = options.testOnlyRecipients || config.smtp.testOnlyRecipients;
  if (allowlist.length) {
    log(`TEST MODE: only sending to allowlisted recipient(s): ${allowlist.join(', ')} — everything else will be skipped`);
  }

  const ACTION_META = {
    reminder: { counterKey: 'sentReminder', mark: sheets.markReminderSent },
    overdue: { counterKey: 'sentOverdue', mark: sheets.markOverdueSent },
    final: { counterKey: 'sentFinal', mark: sheets.markFinalNoticeSent },
  };

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

    const attachments = [{ filename: 'logo.png', path: LOGO_PATH, cid: 'logo' }];
    if (row.ksefNumber) {
      try {
        const pdfBuffer = await downloadAttachment(auth, `${row.ksefNumber}.pdf`);
        attachments.push({ filename: safeAttachmentName(row.invoiceNumber), content: pdfBuffer });
      } catch (err) {
        log(`WARNING: could not attach PDF for ${row.invoiceNumber}, sending without it: ${err.message}`);
      }
    } else {
      log(`No KSeF number on file for ${row.invoiceNumber} — sending without PDF attachment`);
    }

    try {
      await transporter.sendMail({
        from: config.smtp.from,
        to: email,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        attachments,
      });
    } catch (err) {
      summary.failed++;
      log(`Failed to send ${action} email for ${row.invoiceNumber}: ${err.message}`);
      continue;
    }

    const { counterKey, mark } = ACTION_META[action];

    summary[counterKey]++;
    log(`Sent ${action} email for ${row.invoiceNumber} to ${email}`);

    try {
      await mark(auth, row.rowNumber, formatDatePl(todayISO));
    } catch (err) {
      summary.failedToRecord++;
      log(`WARNING: sent ${action} email for ${row.invoiceNumber} to ${email} but failed to record it in the sheet (row ${row.rowNumber}) — a duplicate may be sent next run: ${err.message}`);
    }
  }

  log(`Reminder run completed: ${summary.sentReminder} reminder(s), ${summary.sentOverdue} overdue, ${summary.sentFinal} final notice(s), ${summary.skippedNoContact} skipped (no contact), ${summary.skippedNotAllowlisted} skipped (not allowlisted), ${summary.failed} failed, ${summary.failedToRecord} sent but not recorded`);
  return summary;
}

module.exports = {
  isUnpaidStatus, needsReminder, needsOverdue, needsFinalNotice, decideAction, buildEmail,
  createTransport, runReminders,
};
