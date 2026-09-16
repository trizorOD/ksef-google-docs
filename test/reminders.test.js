const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isUnpaidStatus, needsReminder, needsOverdue, needsFinalNotice, decideAction, buildEmail,
} = require('../reminders');

test('isUnpaidStatus is an allowlist: only "не оплачено" (case/whitespace-insensitive) qualifies', () => {
  assert.equal(isUnpaidStatus('не оплачено'), true);
  assert.equal(isUnpaidStatus(' Не Оплачено '), true);
  assert.equal(isUnpaidStatus('НЕ ОПЛАЧЕНО'), true);
  assert.equal(isUnpaidStatus(''), false); // blank status does not qualify
  assert.equal(isUnpaidStatus('Cancelled'), false);
  assert.equal(isUnpaidStatus('Paid'), false);
  assert.equal(isUnpaidStatus('оплачено'), false);
});

test('needsReminder is true only when due date is exactly tomorrow and not yet sent', () => {
  const today = '2026-09-10';
  assert.equal(needsReminder({ dueDate: '2026-09-11', reminderSent: '' }, today), true);
  assert.equal(needsReminder({ dueDate: '2026-09-11', reminderSent: '10-09-2026' }, today), false);
  assert.equal(needsReminder({ dueDate: '2026-09-12', reminderSent: '' }, today), false);
  assert.equal(needsReminder({ dueDate: '2026-09-10', reminderSent: '' }, today), false);
  assert.equal(needsReminder({ dueDate: '', reminderSent: '' }, today), false);
});

test('needsOverdue is a single-shot: true once due date is in the past and not yet sent, with catch-up', () => {
  const today = '2026-09-10';
  assert.equal(needsOverdue({ dueDate: '2026-09-09', overdueSent: '' }, today), true);
  assert.equal(needsOverdue({ dueDate: '2026-08-01', overdueSent: '' }, today), true); // catch-up
  assert.equal(needsOverdue({ dueDate: '2026-09-10', overdueSent: '' }, today), false); // due today, not overdue yet
});

test('needsOverdue never fires again once already sent (no repeat — that is needsFinalNotice\'s job now)', () => {
  assert.equal(needsOverdue({ dueDate: '2026-08-01', overdueSent: '02-08-2026' }, '2026-09-10'), false);
});

test('needsFinalNotice is false before FINAL_NOTICE_DELAY_DAYS have passed since the due date', () => {
  const dueDate = '2026-09-01';
  assert.equal(needsFinalNotice({ dueDate, finalNoticeSent: '' }, '2026-09-07'), false); // 6 days
  assert.equal(needsFinalNotice({ dueDate, finalNoticeSent: '' }, '2026-09-08'), true); // 7 days — boundary
});

test('needsFinalNotice re-sends every FINAL_NOTICE_REPEAT_DAYS while unpaid', () => {
  const dueDate = '2026-09-01';
  // sent yesterday -> too soon
  assert.equal(needsFinalNotice({ dueDate, finalNoticeSent: '16-09-2026' }, '2026-09-17'), false);
  // sent exactly 7 days ago -> follow-up due (boundary, inclusive)
  assert.equal(needsFinalNotice({ dueDate, finalNoticeSent: '10-09-2026' }, '2026-09-17'), true);
  // sent 10 days ago
  assert.equal(needsFinalNotice({ dueDate, finalNoticeSent: '07-09-2026' }, '2026-09-17'), true);
});

test('needsFinalNotice treats an unparseable finalNoticeSent value as already handled (no resend)', () => {
  assert.equal(needsFinalNotice({ dueDate: '2026-09-01', finalNoticeSent: 'not-a-date' }, '2026-09-17'), false);
});

test('decideAction escalates reminder -> overdue -> final, only for status "не оплачено"', () => {
  const today = '2026-09-10';
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-11', status: 'не оплачено', reminderSent: '', overdueSent: '', finalNoticeSent: '' }, today),
    'reminder'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-09', status: 'не оплачено', reminderSent: '', overdueSent: '', finalNoticeSent: '' }, today),
    'overdue'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-08-20', status: 'не оплачено', reminderSent: '', overdueSent: '21-08-2026', finalNoticeSent: '' }, today),
    'final',
    '7+ days past due, overdue already sent once -> final notice'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-08-01', status: 'не оплачено', reminderSent: '', overdueSent: '', finalNoticeSent: '' }, today),
    'final',
    'catch-up: far enough past due that final wins even though overdue was never sent'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-11', status: 'Paid', reminderSent: '', overdueSent: '', finalNoticeSent: '' }, today),
    null
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-01', status: 'Cancelled', reminderSent: '', overdueSent: '', finalNoticeSent: '' }, today),
    null,
    'a cancelled invoice must never be emailed, even past its due date'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-01', status: '', reminderSent: '', overdueSent: '', finalNoticeSent: '' }, today),
    null,
    'blank status does not qualify — someone must explicitly mark it "не оплачено"'
  );
  assert.equal(
    decideAction({ invoiceNumber: '', dueDate: '2026-09-11', status: 'не оплачено', reminderSent: '', overdueSent: '', finalNoticeSent: '' }, today),
    null
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '', status: 'не оплачено', reminderSent: '', overdueSent: '', finalNoticeSent: '' }, today),
    null
  );
});

test('buildEmail renders the reminder template (text + html) with row data', () => {
  const rendered = buildEmail('reminder', {
    invoiceNumber: 'FV/1/2026', grossAmount: 1230.5, issueDate: '2026-09-01', dueDate: '2026-09-11',
  });
  assert.ok(rendered.subject.includes('FV/1/2026'));
  assert.ok(rendered.text.includes('1230,50'));
  assert.ok(!rendered.text.includes('['));
  assert.ok(rendered.html.includes('FV/1/2026'));
  assert.ok(rendered.html.includes('1230,50'));
  assert.ok(rendered.html.includes('cid:logo'));
  assert.ok(rendered.html.includes('https://finespirits.pl/'));
  assert.ok(!rendered.html.includes('['));
});

test('buildEmail renders the overdue template (text + html) with row data', () => {
  const rendered = buildEmail('overdue', {
    invoiceNumber: 'FV/2/2026', grossAmount: 500, issueDate: '2026-08-01', dueDate: '2026-09-09',
  });
  assert.ok(rendered.subject.includes('FV/2/2026'));
  assert.ok(rendered.text.includes('01-08-2026'));
  assert.ok(rendered.text.includes('09-09-2026'));
  assert.ok(!rendered.text.includes('['));
  assert.ok(rendered.html.includes('01-08-2026'));
  assert.ok(rendered.html.includes('09-09-2026'));
  assert.ok(rendered.html.includes('cid:logo'));
  assert.ok(!rendered.html.includes('['));
});

test('buildEmail renders the final notice template (text + html), using the due date (not issue date) for [DATA]', () => {
  const rendered = buildEmail('final', {
    invoiceNumber: 'FV/3/2026', grossAmount: 750.25, issueDate: '2026-08-01', dueDate: '2026-09-09',
  });
  assert.ok(rendered.subject.includes('Ostateczne wezwanie'));
  assert.ok(rendered.text.includes('FV/3/2026'));
  assert.ok(rendered.text.includes('750,25'));
  assert.ok(rendered.text.includes('09-09-2026')); // the due date
  assert.ok(!rendered.text.includes('01-08-2026')); // NOT the issue date
  assert.ok(!rendered.text.includes('['));
  assert.ok(rendered.html.includes('750,25'));
  assert.ok(rendered.html.includes('09-09-2026'));
  assert.ok(!rendered.html.includes('01-08-2026'));
  assert.ok(rendered.html.includes('cid:logo'));
  assert.ok(!rendered.html.includes('['));
});
