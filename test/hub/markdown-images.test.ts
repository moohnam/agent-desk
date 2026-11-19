import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMarkdownImage, rasterMediaType } from '../../hub/src/markdown-images.ts';

test('external images have a raster MIME type derived from bytes', () => {
  assert.equal(rasterMediaType(Buffer.from('89504e470d0a1a0a', 'hex')), 'image/png');
  assert.equal(rasterMediaType(Buffer.from('ffd8ff', 'hex')), 'image/jpeg');
  assert.equal(rasterMediaType(Buffer.from('RIFFxxxxWEBPVP8 ')), 'image/webp');
  for (const data of ['<html>', '<svg/>', 'RIFFxxxxWEBP', 'GIF89a', ''])
    assert.equal(rasterMediaType(Buffer.from(data)), undefined);
});

test('image loading rejects local, credential-bearing and nonstandard-port URLs before requesting', async () => {
  const signal = new AbortController().signal;
  for (const url of ['http://127.0.0.1/image', 'http://[::1]/image', 'https://mac.local/image',
    'https://user:secret@images.example/image', 'https://images.example:8080/image', 'file:///image.png']) {
    await assert.rejects(loadMarkdownImage(url, signal), { status: 400 });
  }
});
