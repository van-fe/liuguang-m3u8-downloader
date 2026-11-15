/** An explicit empty custom title stays empty; placeholders apply only to detected titles. */
export function getStreamTitle(stream) {
  if (stream && Object.hasOwn(stream, 'customTitle')) return typeof stream.customTitle === 'string' ? stream.customTitle.trim() : '';
  const title = typeof stream?.title === 'string' ? stream.title.trim() : '';
  return /^(?:网页视频|X\s*视频|视频源(?:\s*\d+)?|视频)$/iu.test(title) ? '' : title;
}
