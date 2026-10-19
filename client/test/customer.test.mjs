import test from 'node:test';
import assert from 'node:assert/strict';

import { walletSplit, entryLabel, referralMessage } from '../src/wallet.js';
import { faqEntries, formatTime } from '../src/faq.js';
import { deadlineMessage, deadlineRisk, daysUntilDeadline, etaText, RISK } from '../src/deadline.js';

const subWith = (overrides = {}) => ({
  carryForwardDeadline: '2026-11-20',
  mealsBeyondDeadline: 0,
  remainingMeals: 4,
  expired: false,
  ...overrides
});

const today = new Date(Date.UTC(2026, 10, 15));

test('wallet credit never exceeds the bill', () => {
  assert.deepEqual(walletSplit({ total: 100, balance: 250, useWallet: true }), { credit: 100, payable: 0 });
});

test('a partial balance leaves the rest to pay', () => {
  assert.deepEqual(walletSplit({ total: 299, balance: 50, useWallet: true }), { credit: 50, payable: 249 });
});

test('declining the wallet charges the full total', () => {
  assert.deepEqual(walletSplit({ total: 299, balance: 50, useWallet: false }), { credit: 50, payable: 299 });
});

test('an empty wallet cannot discount anything', () => {
  assert.deepEqual(walletSplit({ total: 299, balance: 0, useWallet: true }), { credit: 0, payable: 299 });
});

test('ledger reasons read as plain English', () => {
  assert.equal(entryLabel('referral_reward'), 'Friend used your code');
  assert.equal(entryLabel('order_payment'), 'Used on an order');
  assert.equal(entryLabel('something_new'), 'something new');
});

test('the share message carries the code', () => {
  assert.ok(referralMessage('ESHWAR9747').includes('ESHWAR9747'));
});

test('cutoff times read the way customers say them', () => {
  assert.equal(formatTime('11:00'), '11 am');
  assert.equal(formatTime('18:30'), '6:30 pm');
  assert.equal(formatTime('12:00'), '12 pm');
  assert.equal(formatTime('00:30'), '12:30 am');
  assert.equal(formatTime('later'), 'later');
});

test('the FAQ quotes the kitchen configured cutoffs', () => {
  const answers = faqEntries({ lunchCutoffTime: '10:00', dinnerCutoffTime: '17:30' })
    .map((entry) => entry.answer)
    .join(' ');
  assert.ok(answers.includes('10 am'));
  assert.ok(answers.includes('5:30 pm'));
  assert.ok(!answers.includes('11 am'));
});

test('the FAQ covers every topic the kitchen is asked about', () => {
  const text = faqEntries({}).map((e) => `${e.question} ${e.answer}`).join(' ').toLowerCase();
  for (const topic of ['carried forward', 'holiday', 'kitchen issue', 'closes at']) {
    assert.ok(text.includes(topic), `missing ${topic}`);
  }
});

test('a far-off deadline is not worth nagging about', () => {
  assert.equal(deadlineRisk(subWith({ carryForwardDeadline: '2026-12-25' }), today), RISK.none);
});

test('a deadline within a week warns', () => {
  assert.equal(deadlineRisk(subWith(), today), RISK.approaching);
});

test('meals that no longer fit are the urgent case', () => {
  assert.equal(deadlineRisk(subWith({ mealsBeyondDeadline: 2 }), today), RISK.overflowing);
});

test('a plan with nothing left to eat is not at risk', () => {
  assert.equal(deadlineRisk(subWith({ remainingMeals: 0 }), today), RISK.none);
});

test('an expired plan is past warning', () => {
  assert.equal(deadlineRisk(subWith({ expired: true, mealsBeyondDeadline: 3 }), today), RISK.none);
});

test('days are counted whole, and go negative once passed', () => {
  assert.equal(daysUntilDeadline(subWith(), today), 5);
  assert.equal(daysUntilDeadline(subWith({ carryForwardDeadline: '2026-11-10' }), today), -5);
});

test('the urgent message names the count and the date', () => {
  const message = deadlineMessage(subWith({ mealsBeyondDeadline: 2 }), today);
  assert.ok(message.includes('2 meals'));
  assert.ok(message.includes('20 Nov'));
});

test('one lost meal is not called "1 meals"', () => {
  assert.ok(deadlineMessage(subWith({ mealsBeyondDeadline: 1 }), today).startsWith('1 meal '));
});

test('the countdown reads naturally on the last days', () => {
  assert.ok(deadlineMessage(subWith(), today).includes('in 5 days'));
  assert.ok(deadlineMessage(subWith({ carryForwardDeadline: '2026-11-16' }), today).includes('tomorrow'));
  assert.ok(deadlineMessage(subWith({ carryForwardDeadline: '2026-11-15' }), today).includes('today'));
});

test('a safe plan is told nothing', () => {
  assert.equal(deadlineMessage(subWith({ carryForwardDeadline: '2026-12-25' }), today), null);
});

test('tracking explains itself before the driver sets off', () => {
  assert.match(etaText({ trackable: false, status: 'preparing' }), /out for delivery/);
  assert.match(etaText({ trackable: false, status: 'delivered' }), /delivered/);
});

test('tracking reports eta, queue position and distance', () => {
  const text = etaText({ trackable: true, etaMinutes: 12, stopsAway: 2, distanceKm: 3.4 });
  assert.ok(text.includes('About 12 min away'));
  assert.ok(text.includes('2 stop(s) before you'));
  assert.ok(text.includes('3.4 km'));
});

test('the customer being next is said plainly', () => {
  assert.ok(etaText({ trackable: true, etaMinutes: 1, stopsAway: 0 }).includes('Arriving now'));
  assert.ok(etaText({ trackable: true, etaMinutes: 1, stopsAway: 0 }).includes('you are next'));
});

test('a trackable order with no numbers still says something', () => {
  assert.equal(etaText({ trackable: true }), 'On the way');
});
