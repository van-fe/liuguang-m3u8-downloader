import { sanitizeDiagnosticValue } from './diagnostics.js';

export const DIAGNOSTIC_STORAGE_KEY = 'liuguangDiagnosticReportsV1';
export const MAX_DIAGNOSTIC_REPORTS = 10;
export const MAX_DIAGNOSTIC_BYTES = 100 * 1024;
const encoder = new TextEncoder();
const terminal = new Set(['complete', 'error', 'cancelled']);
const privateKeys = new Set([
  'url', 'uri', 'posturl', 'sourceurl', 'mediaurl', 'videourl', 'originalurl', 'targeturl',
  'title', 'filename', 'filepath', 'path', 'fullpath', 'hostname', 'host', 'domain', 'address',
  'postid', 'mediaid', 'headers', 'requestheaders', 'responseheaders', 'cookie', 'cookies',
  'authorization', 'auth', 'token', 'signature', 'signedurl', 'referer', 'referrer'
]);

function reportId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(value)) throw new Error('诊断任务编号无效');
  return value;
}

const encodedSize = value => encoder.encode(JSON.stringify(value)).byteLength;
const clone = value => JSON.parse(JSON.stringify(value));

function removePrivateFields(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(-200).map(removePrivateFields);
  return Object.fromEntries(Object.entries(value).filter(([key]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return !privateKeys.has(normalized) && !normalized.endsWith('url') && !normalized.endsWith('uri');
  }).map(([key, item]) => [key, key.toLowerCase() === 'source' && item && typeof item === 'object' && !Array.isArray(item)
    ? { ...(typeof item.format === 'string' ? { format: item.format } : {}), ...(typeof item.platform === 'string' ? { platform: item.platform } : {}) }
    : removePrivateFields(item)]));
}

function shrink(value, { stringLength, arrayLength, keys, depth }, level = 0) {
  if (typeof value === 'string') return value.length > stringLength ? `${value.slice(0, stringLength)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (level >= depth) return '[内容已截短]';
  if (Array.isArray(value)) return value.slice(-arrayLength).map(item => shrink(item, { stringLength, arrayLength, keys, depth }, level + 1));
  return Object.fromEntries(Object.entries(value).slice(0, keys).map(([key, item]) => [key, shrink(item, { stringLength, arrayLength, keys, depth }, level + 1)]));
}

/** Redact again at the storage boundary and cap the UTF-8 size of each report. */
export function boundDiagnosticReport(jobId, report) {
  reportId(jobId);
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('诊断报告格式无效');
  let original;
  try { original = sanitizeDiagnosticValue(removePrivateFields(clone(report))); }
  catch { throw new Error('诊断报告无法序列化'); }
  original.jobId = jobId;
  if (!Number.isSafeInteger(original.schemaVersion) || original.schemaVersion < 1) original.schemaVersion = 1;
  if (encodedSize(original) <= MAX_DIAGNOSTIC_BYTES) return original;
  for (let pass = 0; pass < 7; pass++) {
    const bounded = shrink(original, {
      stringLength: Math.max(64, 4096 / 2 ** pass),
      arrayLength: Math.max(2, Math.floor(100 / 2 ** pass)),
      keys: Math.max(5, Math.floor(80 / 2 ** pass)),
      depth: Math.max(5, 12 - pass)
    });
    bounded.jobId = jobId;
    bounded.schemaVersion = original.schemaVersion;
    bounded.diagnosticTruncated = true;
    if (encodedSize(bounded) <= MAX_DIAGNOSTIC_BYTES) return bounded;
  }
  return {
    schemaVersion: original.schemaVersion, jobId, status: String(original.status || '').slice(0, 200),
    diagnosticTruncated: true, reportTail: JSON.stringify(original).slice(-8192)
  };
}

/** Serialize reads and mutations so concurrent updates cannot lose job reports. */
export function createDiagnosticStore(storageArea) {
  if (!storageArea?.get || !storageArea?.set) throw new TypeError('缺少诊断存储接口');
  let pending = Promise.resolve();
  const run = callback => {
    const operation = pending.then(callback);
    pending = operation.catch(() => {});
    return operation;
  };
  const read = async () => {
    const saved = (await storageArea.get(DIAGNOSTIC_STORAGE_KEY))[DIAGNOSTIC_STORAGE_KEY];
    if (!Array.isArray(saved)) return [];
    const seen = new Set();
    const reports = [];
    for (const report of saved) {
      if (!report || typeof report.jobId !== 'string' || seen.has(report.jobId)) continue;
      try { reports.push(boundDiagnosticReport(report.jobId, report)); seen.add(report.jobId); }
      catch { /* Ignore one malformed legacy record without losing the others. */ }
      if (reports.length === MAX_DIAGNOSTIC_REPORTS) break;
    }
    return reports;
  };
  const save = reports => storageArea.set({ [DIAGNOSTIC_STORAGE_KEY]: reports });
  return {
    upsert(jobId, report) {
      return run(async () => {
        let bounded = boundDiagnosticReport(jobId, report);
        const reports = await read();
        const previous = reports.find(item => item.jobId === jobId);
        if (previous && terminal.has(previous.status)) {
          bounded = boundDiagnosticReport(jobId, { ...bounded, status: previous.status, ...(previous.completedAt ? { completedAt: previous.completedAt } : {}) });
        }
        await save([bounded, ...reports.filter(item => item.jobId !== jobId)].slice(0, MAX_DIAGNOSTIC_REPORTS));
        return clone(bounded);
      });
    },
    mark(jobId, patch) {
      return run(async () => {
        reportId(jobId);
        const reports = await read();
        const index = reports.findIndex(report => report.jobId === jobId);
        if (index < 0) return null;
        reports[index] = boundDiagnosticReport(jobId, { ...reports[index], ...patch });
        await save(reports);
        return clone(reports[index]);
      });
    },
    list() { return run(async () => clone(await read())); },
    get(jobId) { return run(async () => { reportId(jobId); return clone((await read()).find(report => report.jobId === jobId) || null); }); },
    clear() { return run(async () => { await save([]); }); }
  };
}
