const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isUnpaidStatus, needsReminder, needsOverdue, decideAction, buildEmail,
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

test('needsOverdue is true once due date is in the past and not yet sent, with catch-up', () => {
  const today = '2026-09-10';
  assert.equal(needsOverdue({ dueDate: '2026-09-09', overdueSent: '' }, today), true);
  assert.equal(needsOverdue({ dueDate: '2026-08-01', overdueSent: '' }, today), true); // catch-up
  assert.equal(needsOverdue({ dueDate: '2026-09-10', overdueSent: '' }, today), false); // due today, not overdue yet
});

test('needsOverdue re-sends the follow-up every 7 days while still unpaid', () => {
  const today = '2026-09-17';
  // sent yesterday -> too soon
  assert.equal(needsOverdue({ dueDate: '2026-09-01', overdueSent: '16-09-2026' }, today), false);
  // sent 3 days ago -> still too soon
  assert.equal(needsOverdue({ dueDate: '2026-09-01', overdueSent: '14-09-2026' }, today), false);
  // sent exactly 7 days ago -> follow-up due (boundary, inclusive)
  assert.equal(needsOverdue({ dueDate: '2026-09-01', overdueSent: '10-09-2026' }, today), true);
  // sent 10 days ago -> overdue for a follow-up
  assert.equal(needsOverdue({ dueDate: '2026-09-01', overdueSent: '07-09-2026' }, today), true);
});

test('needsOverdue treats an unparseable overdueSent value as already handled (no resend)', () => {
  assert.equal(needsOverdue({ dueDate: '2026-09-01', overdueSent: 'not-a-date' }, '2026-09-17'), false);
});

test('decideAction picks reminder, overdue, or null — only for status "не оплачено"', () => {
  const today = '2026-09-10';
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-11', status: 'не оплачено', reminderSent: '', overdueSent: '' }, today),
    'reminder'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-01', status: 'не оплачено', reminderSent: '', overdueSent: '' }, today),
    'overdue'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-11', status: 'Paid', reminderSent: '', overdueSent: '' }, today),
    null
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-01', status: 'Cancelled', reminderSent: '', overdueSent: '' }, today),
    null,
    'a cancelled invoice must never be emailed, even past its due date'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-01', status: '', reminderSent: '', overdueSent: '' }, today),
    null,
    'blank status does not qualify — someone must explicitly mark it "не оплачено"'
  );
  assert.equal(
    decideAction({ invoiceNumber: '', dueDate: '2026-09-11', status: 'не оплачено', reminderSent: '', overdueSent: '' }, today),
    null
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '', status: 'не оплачено', reminderSent: '', overdueSent: '' }, today),
    null
  );
});

test('buildEmail renders the reminder template with row data', () => {
  const rendered = buildEmail('reminder', {
    invoiceNumber: 'FV/1/2026', grossAmount: 1230.5, issueDate: '2026-09-01', dueDate: '2026-09-11',
  });
  assert.ok(rendered.subject.includes('FV/1/2026'));
  assert.ok(rendered.body.includes('1230,50'));
  assert.ok(!rendered.body.includes('['));
});

test('buildEmail renders the overdue template with row data', () => {
  const rendered = buildEmail('overdue', {
    invoiceNumber: 'FV/2/2026', grossAmount: 500, issueDate: '2026-08-01', dueDate: '2026-09-09',
  });
  assert.ok(rendered.subject.includes('FV/2/2026'));
  assert.ok(rendered.body.includes('01-08-2026'));
  assert.ok(rendered.body.includes('09-09-2026'));
  assert.ok(!rendered.body.includes('['));
});
