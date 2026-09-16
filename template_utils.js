const fs = require('fs');

function parseTemplateContent(content) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const subjectLine = lines[0] || '';
  const subject = subjectLine.replace(/^Subject:\s*/, '').trim();

  const bodyLines = lines.slice(1);
  while (bodyLines.length && bodyLines[0].trim() === '') bodyLines.shift();
  const body = bodyLines.join('\n').replace(/\n+$/, '');

  return { subject, body };
}

function loadTemplate(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseTemplateContent(content);
}

// Reads a template file as-is, with no subject-line parsing — for HTML
// email bodies, which have no separate "Subject:" line (the subject comes
// from the matching .txt template instead).
function loadHtmlBody(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function substitutePlaceholders(text, vars) {
  return Object.keys(vars).reduce(
    (acc, key) => acc.split(`[${key}]`).join(vars[key] ?? ''),
    text
  );
}

function renderTemplate(template, vars) {
  return {
    subject: substitutePlaceholders(template.subject, vars),
    body: substitutePlaceholders(template.body, vars),
  };
}

function formatAmountPl(amount) {
  const num = Number(amount);
  const safe = Number.isFinite(num) ? num : 0;
  return safe.toFixed(2).replace('.', ',');
}

function formatDatePl(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ''));
  if (!m) return '';
  const [, yyyy, mm, dd] = m;
  return `${dd}-${mm}-${yyyy}`;
}

function parseDatePl(dmyDate) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(dmyDate || ''));
  if (!m) return '';
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

function warsawTodayISO(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

function addDaysISO(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

module.exports = {
  parseTemplateContent,
  loadTemplate,
  loadHtmlBody,
  substitutePlaceholders,
  renderTemplate,
  formatAmountPl,
  formatDatePl,
  parseDatePl,
  warsawTodayISO,
  addDaysISO,
};
