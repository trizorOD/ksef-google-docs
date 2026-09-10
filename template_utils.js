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
  const fs = require('fs');
  const content = fs.readFileSync(filePath, 'utf8');
  return parseTemplateContent(content);
}

function renderTemplate(template, vars) {
  const substitute = (text) =>
    Object.keys(vars).reduce(
      (acc, key) => acc.split(`[${key}]`).join(vars[key] ?? ''),
      text
    );
  return { subject: substitute(template.subject), body: substitute(template.body) };
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
  renderTemplate,
  formatAmountPl,
  formatDatePl,
  warsawTodayISO,
  addDaysISO,
};
