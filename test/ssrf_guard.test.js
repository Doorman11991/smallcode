// Regression tests for the SSRF guard. Run with `node --test test/`.
//
// What was broken before the fix:
//   1. `isAlwaysBlocked` matched on a dotted-quad regex only, so
//      `http://[::ffff:169.254.169.254]/` (and its hex / expanded forms)
//      slipped past — Node's URL parser normalizes the hostname to
//      `[::ffff:a9fe:a9fe]`, but the OS still routes the connection to the
//      underlying 169.254.169.254 IMDS endpoint.
//   2. With `LLM_ALLOW_PUBLIC_ENDPOINTS=1`, the only barrier between an
//      LLM-supplied web_fetch URL and cloud metadata is `isAlwaysBlocked`,
//      so the same bypass leaked AWS IMDS via web_fetch in production mode.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assertEndpointAllowed } = require('../src/compiled/providers/ssrf_guard');

function blocked(url, env = {}) {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try {
    assertEndpointAllowed(url);
    return null;
  } catch (e) {
    return e.message;
  } finally {
    process.env = prev;
  }
}

test('IMDS IPv4-mapped IPv6 (dotted) is blocked under LLM_ALLOW_PUBLIC_ENDPOINTS=1', () => {
  const msg = blocked('http://[::ffff:169.254.169.254]/latest/meta-data/', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /metadata\/link-local/.test(msg), `expected block, got: ${msg}`);
});

test('IMDS IPv4-mapped IPv6 (hex) is blocked under LLM_ALLOW_PUBLIC_ENDPOINTS=1', () => {
  const msg = blocked('http://[::ffff:a9fe:a9fe]/latest/meta-data/', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /metadata\/link-local/.test(msg), `expected block, got: ${msg}`);
});

test('IMDS IPv4-mapped IPv6 (expanded zeros) is blocked under LLM_ALLOW_PUBLIC_ENDPOINTS=1', () => {
  const msg = blocked('http://[0:0:0:0:0:ffff:169.254.169.254]/latest/meta-data/', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /metadata\/link-local/.test(msg), `expected block, got: ${msg}`);
});

test('IMDS dotted-quad remains blocked', () => {
  const msg = blocked('http://169.254.169.254/latest/meta-data/', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /metadata\/link-local/.test(msg));
});

test('GCP metadata.google.internal remains blocked', () => {
  const msg = blocked('http://metadata.google.internal/computeMetadata/v1/', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /metadata\/link-local/.test(msg));
});

test('AWS IPv6 IMDS (fd00:ec2::254) remains blocked', () => {
  const msg = blocked('http://[fd00:ec2::254]/latest/meta-data/', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /metadata\/link-local/.test(msg));
});

test('link-local range (169.254.x.x) blocked even outside IMDS literal', () => {
  const msg = blocked('http://169.254.1.5/', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /metadata\/link-local/.test(msg));
});

test('CGNAT 100.64.0.0/10 blocked', () => {
  const msg = blocked('http://100.100.0.1/', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /metadata\/link-local/.test(msg));
});

test('legitimate public endpoint allowed when LLM_ALLOW_PUBLIC_ENDPOINTS=1', () => {
  assert.strictEqual(blocked('https://api.openai.com/v1/chat/completions', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' }), null);
});

test('loopback http://127.0.0.1 allowed in default mode (no env flags)', () => {
  assert.strictEqual(blocked('http://127.0.0.1:11434/v1/chat', { LLM_ALLOW_PUBLIC_ENDPOINTS: '', LLM_ENDPOINT_ALLOWLIST: '' }), null);
});

test('RFC1918 http://192.168.x.x allowed in default mode', () => {
  assert.strictEqual(blocked('http://192.168.1.10:8080/v1/chat', { LLM_ALLOW_PUBLIC_ENDPOINTS: '', LLM_ENDPOINT_ALLOWLIST: '' }), null);
});

test('explicit allowlist origin match works (not raw prefix)', () => {
  // The pre-fix .ts version had a `endpoint.startsWith(a)` bypass; the
  // .js + new .ts use origin equality. Both should accept the exact origin
  // and reject the prefix-spoof.
  assert.strictEqual(blocked('https://api.openai.com/v1/chat', {
    LLM_ALLOW_PUBLIC_ENDPOINTS: '',
    LLM_ENDPOINT_ALLOWLIST: 'https://api.openai.com',
  }), null);
  const msg = blocked('https://api.openai.com.attacker.com/v1/chat', {
    LLM_ALLOW_PUBLIC_ENDPOINTS: '',
    LLM_ENDPOINT_ALLOWLIST: 'https://api.openai.com',
  });
  assert.ok(msg && /not in LLM_ENDPOINT_ALLOWLIST/.test(msg), `expected block, got: ${msg}`);
});

test('non-http(s) scheme rejected', () => {
  const msg = blocked('file:///etc/passwd', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /Endpoint must use http/.test(msg));
});

test('invalid URL rejected with clear message', () => {
  const msg = blocked('http://[malformed', { LLM_ALLOW_PUBLIC_ENDPOINTS: '1' });
  assert.ok(msg && /Invalid endpoint URL/.test(msg));
});
