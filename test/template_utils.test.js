const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  parseTemplateContent,
  loadTemplate,
  renderTemplate,
  formatAmountPl,
  formatDatePl,
  parseDatePl,
  warsawTodayISO,
  addDaysISO,
} = require('../template_utils');

test('parseTemplateContent splits the subject line from the body', () => {
  const content = 'Subject: Hello [NAME]\n\nBody line one.\nBody line two.\n';
  const { subject, body } = parseTemplateContent(content);
  assert.equal(subject, 'Hello [NAME]');
  assert.equal(body, 'Body line one.\nBody line two.');
});

test('renderTemplate substitutes every placeholder in subject and body', () => {
  const template = {
    subject: 'Faktura [NUMER]',
    body: 'Kwota: [KWOTA] PLN, termin: [TERMIN PŁATNOŚCI], wystawiono [DATA]',
  };
  const rendered = renderTemplate(template, {
    NUMER: 'FA/1/2026',
    KWOTA: '123,45',
    DATA: '01-09-2026',
    'TERMIN PŁATNOŚCI': '10-09-2026',
  });
  assert.equal(rendered.subject, 'Faktura FA/1/2026');
  assert.equal(rendered.body, 'Kwota: 123,45 PLN, termin: 10-09-2026, wystawiono 01-09-2026');
});

test('formatAmountPl formats numbers with a comma decimal separator', () => {
  assert.equal(formatAmountPl(1234.5), '1234,50');
  assert.equal(formatAmountPl('999.999'), '1000,00');
  assert.equal(formatAmountPl(''), '0,00');
  assert.equal(formatAmountPl(undefined), '0,00');
});

test('formatDatePl converts an ISO date to dd-MM-yyyy', () => {
  assert.equal(formatDatePl('2026-09-15'), '15-09-2026');
  assert.equal(formatDatePl('2026-01-05T00:00:00'), '05-01-2026');
  assert.equal(formatDatePl(''), '');
  assert.equal(formatDatePl('not-a-date'), '');
});

test('parseDatePl converts a dd-MM-yyyy string back to ISO, the inverse of formatDatePl', () => {
  assert.equal(parseDatePl('15-09-2026'), '2026-09-15');
  assert.equal(parseDatePl(formatDatePl('2026-01-05')), '2026-01-05');
  assert.equal(parseDatePl(''), '');
  assert.equal(parseDatePl('not-a-date'), '');
  assert.equal(parseDatePl('2026-09-15'), ''); // wrong format (ISO, not dd-MM-yyyy)
});

test('addDaysISO adds days across month and year boundaries', () => {
  assert.equal(addDaysISO('2026-09-10', 1), '2026-09-11');
  assert.equal(addDaysISO('2026-09-30', 1), '2026-10-01');
  assert.equal(addDaysISO('2026-12-31', 1), '2027-01-01');
});

test('warsawTodayISO formats a given instant as YYYY-MM-DD in Europe/Warsaw', () => {
  const fixed = new Date('2026-09-10T22:30:00Z'); // CEST is UTC+2 → already Sep 11 locally
  assert.equal(warsawTodayISO(fixed), '2026-09-11');
});

test('reminder.txt loads and renders with the real placeholders', () => {
  const template = loadTemplate(path.join(__dirname, '..', 'templates', 'reminder.txt'));
  assert.match(template.subject, /\[NUMER\]/);
  assert.match(template.body, /\[NUMER\]/);
  assert.match(template.body, /\[KWOTA\]/);
  const rendered = renderTemplate(template, { NUMER: 'FA/1/2026', KWOTA: '100,00', DATA: '', 'TERMIN PŁATNOŚCI': '' });
  assert.ok(!rendered.subject.includes('[NUMER]'));
  assert.ok(!rendered.body.includes('[KWOTA]'));
});

test('overdue.txt loads and renders with the real placeholders', () => {
  const template = loadTemplate(path.join(__dirname, '..', 'templates', 'overdue.txt'));
  assert.match(template.body, /\[TERMIN PŁATNOŚCI\]/);
  assert.match(template.body, /\[DATA\]/);
  const rendered = renderTemplate(template, { NUMER: 'FA/1/2026', KWOTA: '100,00', DATA: '01-09-2026', 'TERMIN PŁATNOŚCI': '09-09-2026' });
  assert.ok(!rendered.body.includes('['));
});
