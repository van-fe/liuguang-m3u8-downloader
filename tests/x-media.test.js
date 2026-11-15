import test from 'node:test';
import assert from 'node:assert/strict';
import { extractXMedia, getXPostId, isXPageUrl, isXMediaUrl, selectXVariant } from '../extension/lib/x-media.js';

const low = 'https://video.twimg.com/ext_tw_video/100/pu/vid/avc1/640x360/low.mp4?tag=12';
const high = 'https://video.twimg.com/ext_tw_video/100/pu/vid/avc1/1280x720/high.mp4?tag=12';
const hls = 'https://video.twimg.com/ext_tw_video/100/pu/pl/master.m3u8?tag=12';
const variant = (url, bitrate = 0) => ({ url, content_type: url.includes('.mp4') ? 'video/mp4' : 'application/x-mpegURL', bitrate });
const media = (id = '100', variants = [variant(low, 832000), variant(high, 2176000), variant(hls)]) => ({ id_str: id, type: 'video', video_info: { variants } });
const tweet = (id, text, videos) => ({ __typename: 'Tweet', rest_id: id, legacy: { id_str: id, full_text: text, extended_entities: { media: videos } } });

test('X page/post URL parsing uses exact hosts and preserves 25-digit IDs as strings', () => {
  assert.equal(getXPostId('https://x.com/name/status/1234567890123456789012345/video/1?s=20'), '1234567890123456789012345');
  assert.equal(getXPostId('https://mobile.twitter.com/i/status/123'), '123');
  assert.equal(getXPostId('https://www.x.com/i/web/status/456'), '456');
  assert.equal(isXPageUrl('https://x.com/home'), true);
  for (const value of ['https://x.com.evil.example/u/status/123', 'https://evil.example/?x=https://x.com/u/status/123', 'https://user:pass@x.com/u/status/123', 'file:///x.com/status/123']) {
    assert.equal(isXPageUrl(value), false);
    assert.equal(getXPostId(value), null);
  }
  assert.equal(getXPostId('https://x.com/u/status/12345678901234567890123456'), null);
  assert.equal(getXPostId('https://x.com/home?status=123'), null);
});

test('X media URL validation accepts only HTTPS media CDN paths and rejects credentials/host suffix attacks', () => {
  for (const value of [low, high, hls, 'https://pbs.twimg.com/tweet_video/animated.mp4']) assert.equal(isXMediaUrl(value), true);
  for (const value of [
    'http://video.twimg.com/a.mp4', 'https://video.twimg.com.evil.example/a.mp4', 'https://evilvideo.twimg.com/a.mp4',
    'https://video.twimg.com@evil.example/a.mp4', 'https://user:pass@video.twimg.com/a.mp4',
    'https://video.twimg.com:8443/a.mp4', 'https://pbs.twimg.com/media/a.mp4',
    'https://pbs.twimg.com/tweet_video/a.m3u8', 'https://video.twimg.com/page?src=a.mp4', 'javascript:alert(1)',
  ]) assert.equal(isXMediaUrl(value), false, value);
});

test('GraphQL media extraction chooses the highest bitrate MP4 and deduplicates repeated variant URLs', () => {
  const source = media();
  source.video_info.variants.push(variant(high, 1280000));
  const result = extractXMedia({ data: { tweetResult: { result: tweet('987654321', '视频正文', [source]) } } });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, '100');
  assert.equal(result[0].postId, '987654321');
  assert.equal(result[0].postUrl, 'https://x.com/i/status/987654321');
  assert.equal(result[0].title, '视频正文');
  assert.equal(result[0].url, high);
  assert.equal(result[0].format, 'mp4');
  assert.equal(result[0].variants.length, 3);
  assert.deepEqual(result[0].variants[0], { url: high, type: 'mp4', bitrate: 2176000, width: 1280, height: 720 });
});

test('quoted and retweeted media keep their own tweet IDs and titles', () => {
  const quotedUrl = 'https://video.twimg.com/amplify_video/200/vid/1920x1080/quoted.mp4';
  const parent = tweet('111', '主帖', [media()]);
  parent.quoted_status_result = { result: tweet('222', '引用帖', [media('200', [variant(quotedUrl, 3000000)])]) };
  parent.legacy.retweeted_status = { id_str: '333', full_text: '转发的原帖', extended_entities: { media: [media('300', [variant('https://pbs.twimg.com/tweet_video/gif.mp4')])] } };
  const results = extractXMedia({ result: parent });
  assert.equal(results.length, 3);
  assert.deepEqual(results.map(value => [value.postId, value.title]).sort(), [['111', '主帖'], ['222', '引用帖'], ['333', '转发的原帖']]);
});

test('legacy globalObjects.tweets maps provide fallback post IDs without mistaking user/media IDs for posts', () => {
  const result = extractXMedia({ globalObjects: { tweets: {
    '123456789': { full_text: 'map 正文', user_id_str: '999', extended_entities: { media: [media('555')] } },
  }, users: { '999': { id_str: '999', name: 'user', description: 'profile' } } } });
  assert.equal(result.length, 1);
  assert.equal(result[0].postId, '123456789');
  assert.equal(result[0].id, '555');
  assert.equal(result[0].title, 'map 正文');
});

test('syndication mediaDetails/video.variants merges duplicates and supports src/type spellings and animated GIFs', () => {
  const gif = 'https://pbs.twimg.com/tweet_video/gif-two.mp4';
  const result = extractXMedia({
    id_str: '54321', text: 'syndication 正文',
    mediaDetails: [media(), { id_str: 'gif-two', type: 'animated_gif', video_info: { variants: [{ src: gif, type: 'video/mp4' }] } }],
    video: { variants: [{ src: low, type: 'video/mp4' }, { src: high, type: 'video/mp4', bitrate: 2176000 }] },
  });
  assert.equal(result.length, 2);
  assert.equal(result.find(value => value.id === '100').url, high);
  assert.equal(result.find(value => value.id === 'gif-two').url, gif);
  assert.ok(result.every(value => value.postId === '54321'));
});

test('API v2 includes media resolves attachment owners and bit_rate variants', () => {
  const result = extractXMedia({
    data: [
      { id: '1000', text: 'first post', attachments: { media_keys: ['7_100'] } },
      { id: '2000', text: 'second post', attachments: { media_keys: ['7_200'] } },
    ],
    includes: { media: [
      { media_key: '7_100', type: 'video', variants: [{ url: low, content_type: 'video/mp4', bit_rate: 832000 }, { url: high, content_type: 'video/mp4', bit_rate: 2176000 }] },
      { media_key: '7_200', type: 'video', variants: [{ url: 'https://video.twimg.com/amplify_video/200/pl/only.m3u8', content_type: 'application/x-mpegURL' }] },
    ] },
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].postId, '1000');
  assert.equal(result[0].title, 'first post');
  assert.equal(result[0].variants[0].bitrate, 2176000);
  assert.equal(result[1].postId, '2000');
  assert.equal(result[1].format, 'hls');
});

test('User legacy entities do not pollute the unique-post fallback for media without an ancestor tweet', () => {
  const result = extractXMedia({
    users: [
      { __typename: 'User', rest_id: '9000', id_str: '9000', text: 'profile metadata', legacy: { id_str: '9000', entities: { description: { urls: [] } } } },
      { rest_id: '9001', legacy: { id_str: '9001', entities: { url: { urls: [] } } } },
    ],
    tweet: { __typename: 'Tweet', rest_id: '12345', legacy: { id_str: '12345', full_text: '唯一的视频帖子' } },
    video: { variants: [variant(high, 2176000)] },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].postId, '12345');
  assert.equal(result[0].postUrl, 'https://x.com/i/status/12345');
  assert.equal(result[0].title, '唯一的视频帖子');
  assert.equal(result[0].url, high);
});

test('GraphQL legacy media entities remain recognizable without full_text', () => {
  const result = extractXMedia({
    rest_id: '2468', legacy: { id_str: '2468', entities: { media: [media()] } },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].postId, '2468');
  assert.equal(result[0].url, high);
});

test('HLS is selected only when there is no MP4, and variant input metadata cannot override the validated URL format', () => {
  assert.equal(selectXVariant([variant(hls, 9000000), variant(low, 1)]).url, low);
  assert.equal(selectXVariant([{ url: hls, type: 'video/mp4' }]).type, 'hls');
  assert.equal(selectXVariant([{ url: high, type: 'hls', bitrate: Infinity }]).bitrate, 0);
  assert.equal(selectXVariant([{ url: 'https://evil.example/video.mp4' }]), null);
  assert.equal(selectXVariant([]), null);
  const result = extractXMedia({ video: { variants: [variant(hls)] } });
  assert.equal(result.length, 1);
  assert.equal(result[0].format, 'hls');
  assert.equal(result[0].postId, null);
  assert.equal(result[0].postUrl, null);
});

test('long titles are normalized and truncated by Unicode character rather than surrogate halves', () => {
  const result = extractXMedia(tweet('1', `  标题\n${'😀'.repeat(150)} `, [media()]));
  assert.equal(Array.from(result[0].title).length, 120);
  assert.ok(result[0].title.startsWith('标题 '));
  assert.ok(result[0].title.endsWith('😀'));
});

test('bounded traversal handles cycles, deep objects, excess results, invalid JSON and absent media', () => {
  const cyclic = tweet('1', 'cycle', [media()]);
  cyclic.self = cyclic;
  assert.equal(extractXMedia(cyclic).length, 1);
  let deep = { video: { variants: [variant(high)] } };
  for (let index = 0; index < 100; index++) deep = { child: deep };
  assert.deepEqual(extractXMedia(deep), []);
  const many = Array.from({ length: 100 }, (_, index) => media(String(index), [variant(`https://video.twimg.com/ext_tw_video/${index}/vid/video.mp4`)]));
  assert.equal(extractXMedia(tweet('1', 'many', many)).length, 25);
  for (const value of [null, undefined, 123, '{bad json', { data: { text: 'no media' } }]) assert.deepEqual(extractXMedia(value), []);
  assert.equal(extractXMedia(JSON.stringify(tweet('2', 'JSON string', [media()])))[0].postId, '2');
});
