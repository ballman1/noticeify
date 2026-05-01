import test from 'node:test';
import assert from 'node:assert/strict';

import { hashIp, geoLookup, validatePayload } from '../services/consent-utils.js';

test('validatePayload rejects unknown category keys', () => {
  const payload = {
    consentId: 'abc123',
    clientId: 'client_1',
    timestamp: new Date().toISOString(),
    source: 'banner',
    categories: { analytics: true, unknown_category: true },
  };

  const result = validatePayload(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('unknown category')));
});

test('validatePayload rejects non-boolean category values', () => {
  const payload = {
    consentId: 'abc123',
    clientId: 'client_1',
    timestamp: new Date().toISOString(),
    source: 'banner',
    categories: { analytics: 'yes' },
  };

  const result = validatePayload(payload);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('must be a boolean')));
});

test('hashIp throws when IP_HASH_SALT is missing', () => {
  const prev = process.env.IP_HASH_SALT;
  delete process.env.IP_HASH_SALT;

  assert.throws(() => hashIp('127.0.0.1'), /IP_HASH_SALT is not configured/);

  if (prev !== undefined) {
    process.env.IP_HASH_SALT = prev;
  }
});

test('hashIp returns stable hash for same day and salt', () => {
  const prev = process.env.IP_HASH_SALT;
  process.env.IP_HASH_SALT = 'test-salt';

  const a = hashIp('203.0.113.10');
  const b = hashIp('203.0.113.10');

  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);

  if (prev !== undefined) {
    process.env.IP_HASH_SALT = prev;
  } else {
    delete process.env.IP_HASH_SALT;
  }
});

test('geoLookup returns nulls for localhost inputs', async () => {
  const result = await geoLookup('127.0.0.1');
  assert.deepEqual(result, { countryCode: null, regionCode: null });
});

test('geoLookup maps country/region from provider response', async () => {
  const oldFetch = global.fetch;
  try {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ country_code: 'us', region_code: 'ca' }),
    });

    const result = await geoLookup('198.51.100.24');
    assert.deepEqual(result, { countryCode: 'US', regionCode: 'CA' });
  } finally {
    global.fetch = oldFetch;
  }
});

test('geoLookup fails open on provider errors', async () => {
  const oldFetch = global.fetch;
  try {
    global.fetch = async () => {
      throw new Error('network down');
    };

    const result = await geoLookup('198.51.100.25');
    assert.deepEqual(result, { countryCode: null, regionCode: null });
  } finally {
    global.fetch = oldFetch;
  }
});

test('geoLookup opens temporary circuit after repeated failures', async () => {
  const oldFetch = global.fetch;
  let callCount = 0;
  try {
    global.fetch = async () => {
      callCount += 1;
      throw new Error('provider down');
    };

    await geoLookup('198.51.100.30');
    await geoLookup('198.51.100.31');
    await geoLookup('198.51.100.32');
    await geoLookup('198.51.100.33');

    assert.ok(callCount <= 3);
  } finally {
    global.fetch = oldFetch;
  }
});
