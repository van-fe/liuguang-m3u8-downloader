import { extractXMedia, getXPostId } from './x-media.js';
import { requestBytes } from './download.js';

// X's public embedded-post endpoint uses this public, post-ID-derived value.
// It is not an account token, and no account cookies or authorization are sent.
export function xEmbedToken(postId) {
  if (!/^\d{1,25}$/.test(String(postId))) throw new Error('X 帖子编号无效');
  return ((Number(postId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export async function resolveXPost(url, { fetchImpl = fetch } = {}) {
  const postId = getXPostId(url);
  if (!postId) throw new Error('请粘贴完整的 X 视频帖子链接，例如 https://x.com/用户名/status/帖子编号');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('X 公开帖子读取超时')), 15000);
  try {
    const endpoint = new URL('https://cdn.syndication.twimg.com/tweet-result');
    endpoint.search = new URLSearchParams({ id: postId, lang: 'en', token: xEmbedToken(postId) });
    const result = await requestBytes(endpoint.href, {
      signal: controller.signal, fetchImpl, retries: 1, credentials: 'omit', maxBytes: 2 * 1024 * 1024
    });
    const payload = JSON.parse(new TextDecoder().decode(result.bytes));
    const items = extractXMedia(payload).filter(item => !item.postId || item.postId === postId);
    if (!items.length) throw new Error('没有可读取的视频');
    return items.map(item => ({ ...item, postId, postUrl: `https://x.com/i/status/${postId}` }));
  } catch (error) {
    throw new Error('暂时无法从公开接口读取这条 X 视频。请在能正常观看该视频的 X 页面中播放，再点击插件的「重新检测」。受保护、已删除或需登录的帖子需要先在 X 页面访问。', { cause: error });
  } finally { clearTimeout(timer); }
}
