import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter } from '../src/limits.js';
import { decodeLogo, safeLogoUrl, sniffImage } from '../src/logo.js';

test('limiter locks after N failures and the lockout doubles', () => {
  const l = new Limiter(5, 1000, 10_000);
  for (let i = 0; i < 4; i++) assert.equal(l.fail('ip', 0), 0);
  assert.equal(l.fail('ip', 0), 1000);
  assert.equal(l.retryAfter('ip', 500), 500);
  assert.equal(l.retryAfter('ip', 1000), 0);
  for (let i = 0; i < 4; i++) l.fail('ip', 2000);
  assert.equal(l.fail('ip', 2000), 2000, 'second lockout doubles');
  l.succeed('ip');
  assert.equal(l.retryAfter('ip', 2001), 0);
});

test('logo magic bytes, SVG and URL schemes', () => {
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
  assert.equal(sniffImage(png), 'image/png');
  assert.equal(decodeLogo(`data:image/png;base64,${png.toString('base64')}`)!.mime, 'image/png');
  assert.throws(() => decodeLogo(`data:image/png;base64,${Buffer.from('<script>').toString('base64')}`), /not a valid/);
  assert.throws(() => decodeLogo(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`), /SVG/);
  assert.throws(() => decodeLogo(`data:image/jpeg;base64,${png.toString('base64')}`), /labeled/);
  assert.throws(() => decodeLogo(`data:image/png;base64,${Buffer.concat([png, Buffer.alloc(1100000)]).toString('base64')}`), /limit is 1 MB/);
  assert.equal(safeLogoUrl('https://x.org/a.png'), 'https://x.org/a.png');
  assert.equal(safeLogoUrl(''), null);
  assert.throws(() => safeLogoUrl('javascript:alert(1)'));
  assert.throws(() => safeLogoUrl('data:image/png;base64,AAAA'));
  assert.throws(() => safeLogoUrl('/logos/1'));
});
