// Diagnostic data deliberately contains no page/media addresses or titles.
const PRIVATE_KEY = /^(?:url|uri|href|src|address|host|hostname|domain|origin|path|postId|postUrl|pageUrl|sourceUrl|videoUrl|mediaUrl|title|filename|fileName|headers|requestHeaders|responseHeaders|cookie|cookies|authorization|token|accessToken|guestToken|csrfToken|keyUri|iv|metadata|tags|comment|description|__proto__|constructor|prototype)$/i;
const LOCAL_MEDIA_FILE = /^(?:t\d+-(?:s\d+\.(?:ts|m4s)|init\d+\.mp4)|track\d+\.m3u8|output\.mp4)$/i;

export function redactDiagnosticText(value, limit = 1200) {
  return String(value ?? '')
    .replace(/\b(?:https?|blob|data|file)(?::|%(?:25)*3a|&#(?:x0*3a|0*58);?|&colon;)[^\s<>"'\u3000-\u303f]+/gi, '[地址已隐藏]')
    .replace(/\b(?:https?|blob|data|file):[^\s<>"'\u3000-\u303f]+/gi, '[地址已隐藏]')
    .replace(/(^|[\s("'=])\/\/[^\s<>"')]+/g, '$1[地址已隐藏]')
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]+)(?![a-z0-9-])(?::\d{1,5})?(?:[/?#][^\s<>"'\u3000-\u303f]*)?/gi, match => LOCAL_MEDIA_FILE.test(match) ? match : '[地址已隐藏]')
    .replace(/\b(?:\d{1,5}\.){3}\d{1,5}(?::\d{1,5})?(?:[/?#][^\s<>"'\u3000-\u303f]*)?/g, match => match.split(/[/:?#]/)[0].split('.').every(part => Number(part) <= 255) ? '[地址已隐藏]' : match)
    .replace(/\b(?:authorization|cookie|set-cookie|x-guest-token|x-csrf-token)\s*[:=][^\r\n]*/gi, '[认证信息已隐藏]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
    .slice(0, limit);
}

/** Applied on collection and again at the persistent-storage boundary. */
export function sanitizeDiagnosticValue(value, depth = 0) {
  if (depth > 10) return '[深度已省略]';
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.slice(0, 200).map(item => sanitizeDiagnosticValue(item, depth + 1));
  if (typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 100)) {
    if (PRIVATE_KEY.test(key) || /(?:cookie|authorization|token|password|secret)/i.test(key)) continue;
    result[redactDiagnosticText(key, 100)] = sanitizeDiagnosticValue(item, depth + 1);
  }
  return result;
}

function appendBounded(entries, entry, head, tail) {
  entries.push(entry);
  if (entries.length > head + tail) entries.splice(head, entries.length - head - tail);
}

export function isRoutineAbort(message) {
  return /^Aborted\((?:native code called abort\(\))?\)(?:\. Build with -sASSERTIONS for more info\.)?\s*$/.test(String(message).trim());
}

export function summarizeTracks(tracks) {
  return [tracks.video, tracks.audio].filter(Boolean).map((track, index) => ({
    role: index === 0 ? 'primary' : 'audio',
    segments: track.segments.length,
    duration: track.duration,
    endList: Boolean(track.endList),
    fragmentedMP4: track.segments.some(segment => Boolean(segment.map)),
    byteRanges: track.segments.filter(segment => Boolean(segment.byteRange)).length,
    discontinuities: track.segments.filter(segment => segment.discontinuity).length,
    encryption: [...new Set(track.segments.map(segment => segment.key?.method || 'NONE'))],
  }));
}

export function createJobDiagnostic(job, settings, { version = '', userAgent = '', now = () => new Date().toISOString() } = {}) {
  let inMetadata = false;
  const report = {
    schemaVersion: 1, jobId: job.id, extensionVersion: version,
    startedAt: now(), updatedAt: now(), status: 'preparing',
    environment: { userAgent: redactDiagnosticText(userAgent, 300) },
    source: { format: job.format === 'mp4' ? 'mp4' : 'hls', platform: job.platform === 'x' ? 'x' : 'web' },
    settings: { taskConcurrency: 'unlimited', concurrency: settings?.concurrency ?? 4, retries: settings?.retries ?? 3, saveAs: job.saveAs !== false },
    tracks: [], progress: {}, events: [],
    ffmpeg: { args: [], exitCode: null, logs: [], ignoredAbortLines: 0, ignoredMetadataLines: 0, totalLogLines: 0 },
    failure: null,
  };
  return {
    report,
    event(event, details = {}) {
      appendBounded(report.events, { ...sanitizeDiagnosticValue(details), at: now(), event }, 15, 65);
      report.updatedAt = now();
    },
    log({ type = 'stderr', message }) {
      if (!message) return;
      report.ffmpeg.totalLogLines++;
      if (/^\s*Metadata:\s*$/i.test(message)) {
        inMetadata = true; report.ffmpeg.ignoredMetadataLines++; return;
      }
      if (inMetadata && /^\s+/.test(message) && !/^\s*(?:Duration|Stream|Input|Output)\b/.test(message)) {
        report.ffmpeg.ignoredMetadataLines++; return;
      }
      inMetadata = false;
      if (isRoutineAbort(message)) { report.ffmpeg.ignoredAbortLines++; return; }
      appendBounded(report.ffmpeg.logs, { at: now(), type, message: redactDiagnosticText(message, 600) }, 25, 75);
    },
    progress(state) {
      report.status = state.status;
      report.updatedAt = now();
      for (const key of ['progress', 'bytes', 'totalSegments', 'completedSegments', 'retryCount']) {
        if (Number.isFinite(state[key])) report.progress[key] = state[key];
      }
    },
    fail(error, stage, cancelled = false) {
      report.status = cancelled ? 'cancelled' : 'error';
      report.failure = { stage, name: String(error?.name || 'Error'), message: redactDiagnosticText(error?.message || error) };
      report.updatedAt = now();
    },
    snapshot() {
      const snapshot = sanitizeDiagnosticValue(report);
      // Keep bounded exports even if a server produces unusually verbose errors.
      const size = () => new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
      while (size() > 80 * 1024 && snapshot.ffmpeg.logs.length > 2) snapshot.ffmpeg.logs.splice(snapshot.ffmpeg.logs.length > 26 ? 25 : 1, 1);
      while (size() > 80 * 1024 && snapshot.events.length > 2) snapshot.events.splice(snapshot.events.length > 16 ? 15 : 1, 1);
      return snapshot;
    },
  };
}

/** Aborted() is also emitted on normal C exits; the return code is authoritative. */
export function describeMergeFailure(exitCode, logs = [], thrown) {
  const messages = logs.map(entry => typeof entry === 'string' ? entry : entry.message).filter(message => message && !isRoutineAbort(message));
  const errors = messages.filter(message => /error|could not|invalid|unsupported|not supported|not found|failed|no such|unable|cannot|does not|no space|memory|malloc|assertion/i.test(message));
  const detail = (errors.length ? errors : messages).slice(-3).join(' ');
  if (/out of memory|memory access out of bounds|cannot enlarge memory|Aborted\(OOM\)|allocation failed|malloc/i.test(`${detail} ${thrown || ''}`)) {
    return 'MP4 合并失败：媒体引擎内存不足或发生内存异常。请导出此任务诊断日志以进一步分析。';
  }
  if (detail) return `MP4 合并失败（退出码 ${exitCode ?? '未知'}）：${redactDiagnosticText(detail, 650)}`;
  const reason = thrown && !isRoutineAbort(String(thrown)) ? ` ${redactDiagnosticText(thrown, 300)}` : '';
  return `MP4 合并失败（退出码 ${exitCode ?? '未知'}）。${reason}请导出此任务诊断日志以进一步分析。`;
}
