const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPaidStatus, needsReminder, needsOverdue, decideAction, buildEmail,
} = require('../reminders');

test('isPaidStatus recognizes English and Russian "paid" text, case/whitespace-insensitive', () => {
  assert.equal(isPaidStatus('Paid'), true);
  assert.equal(isPaidStatus(' paid '), true);
  assert.equal(isPaidStatus('ОПЛАЧЕНО'), true);
  assert.equal(isPaidStatus('оплачено'), true);
  assert.equal(isPaidStatus(''), false);
  assert.equal(isPaidStatus('Unpaid'), false);
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
  assert.equal(needsOverdue({ dueDate: '2026-09-09', overdueSent: '09-09-2026' }, today), false);
  assert.equal(needsOverdue({ dueDate: '2026-09-10', overdueSent: '' }, today), false); // due today, not overdue yet
});

test('decideAction picks reminder, overdue, or null — and skips paid rows', () => {
  const today = '2026-09-10';
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-11', status: '', reminderSent: '', overdueSent: '' }, today),
    'reminder'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-01', status: '', reminderSent: '', overdueSent: '' }, today),
    'overdue'
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '2026-09-11', status: 'Paid', reminderSent: '', overdueSent: '' }, today),
    null
  );
  assert.equal(
    decideAction({ invoiceNumber: '', dueDate: '2026-09-11', status: '', reminderSent: '', overdueSent: '' }, today),
    null
  );
  assert.equal(
    decideAction({ invoiceNumber: 'FV/1', dueDate: '', status: '', reminderSent: '', overdueSent: '' }, today),
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
