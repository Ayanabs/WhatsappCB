'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveTemplate } = require('../core/countdown');

test('templates can show days, hours, or both', () => {
  const target = new Date(Date.now() + (3 * 86400 + 5 * 3600 + 120) * 1000);
  assert.equal(resolveTemplate('Only {days} days and {hours} hours left.', target), 'Only 3 days and 5 hours left.');
  assert.equal(resolveTemplate('Only {hours} hours left.', target), 'Only 77 hours left.');
  assert.equal(resolveTemplate('Only {days} days left.', target), 'Only 3 days left.');
});
