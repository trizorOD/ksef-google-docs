const path = require('path');
const {
  loadTemplate, renderTemplate, formatAmountPl, formatDatePl, addDaysISO,
} = require('./template_utils');

const REMINDER_TEMPLATE_PATH = path.join(__dirname, 'templates', 'reminder.txt');
const OVERDUE_TEMPLATE_PATH = path.join(__dirname, 'templates', 'overdue.txt');

function isPaidStatus(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return normalized === 'paid' || normalized === 'оплачено';
}

function needsReminder(row, todayISO) {
  return !!row.dueDate && !row.reminderSent && row.dueDate === addDaysISO(todayISO, 1);
}

function needsOverdue(row, todayISO) {
  return !!row.dueDate && !row.overdueSent && row.dueDate < todayISO;
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

module.exports = { isPaidStatus, needsReminder, needsOverdue, decideAction, buildEmail };
