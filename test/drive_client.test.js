const test = require('node:test');
const assert = require('node:assert/strict');
const { uploadPdf, replacePdf, downloadPdfByFilename } = require('../drive_client');

test('drive_client exports the expected functions', () => {
  assert.equal(typeof uploadPdf, 'function');
  assert.equal(typeof replacePdf, 'function');
  assert.equal(typeof downloadPdfByFilename, 'function');
});
