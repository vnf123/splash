import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hueFromString, parseTrackName } from '../src/scene.js';

test('从文件名解析艺术家与曲名', () => {
  assert.deepEqual(parseTrackName('Queen+-+Bohemian+Rhapsody.mp3'), {
    artist: 'Queen',
    title: 'Bohemian Rhapsody',
    key: 'Queen - Bohemian Rhapsody',
  });
  assert.equal(parseTrackName('周杰伦 - 晴天.flac').title, '晴天');
  assert.equal(parseTrackName('a-ha.wav').artist, null);
  assert.equal(parseTrackName('only_title.ogg').title, 'only title');
});
import { isAudioFile } from '../src/audio.js';

test('同名曲目得到稳定的主题色', () => {
  assert.equal(hueFromString('Song A'), hueFromString('Song A'));
  const h = hueFromString('雨夜');
  assert.ok(h >= 0 && h < 360);
});

test('按 MIME 或扩展名识别音频文件', () => {
  assert.equal(isAudioFile({ name: 'a.bin', type: 'audio/mpeg' }), true);
  assert.equal(isAudioFile({ name: 'a.FLAC', type: '' }), true);
  assert.equal(isAudioFile({ name: 'photo.jpg', type: 'image/jpeg' }), false);
  assert.equal(isAudioFile(null), false);
});
