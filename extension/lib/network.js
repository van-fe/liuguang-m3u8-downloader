const CHUNK_BYTES = 1024 * 1024;
const IDLE_TIMEOUT_MS = 45000;

function permanent(error, prefix = '') {
  const original = error instanceof Error ? error : new Error(String(error));
  const result = prefix ? new Error(`${prefix}${original.message}`, { cause: original }) : original;
  result.permanent = true;
  return result;
}

function httpUrl(value) {
  let parsed;
  try { parsed = new URL(value); }
  catch { throw permanent(new Error('请使用有效的 HTTP 或 HTTPS 视频地址')); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw permanent(new Error('请使用有效的 HTTP 或 HTTPS 视频地址'));
  }
  return parsed.href;
}

function checkRange(range) {
  if (!range) return;
  if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length)
    || range.length <= 0 || !Number.isSafeInteger(range.offset + range.length)) {
    throw permanent(new Error('分段字节范围无效或超出允许范围'));
  }
}

async function pause(ms, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function diskError(error) {
  if (error?.name === 'QuotaExceededError') {
    return permanent(new Error('浏览器磁盘空间不足，请释放空间后重试'));
  }
  return permanent(error, '本地文件写入失败：');
}

/**
 * Download one resource to a replaceable disk sink with bounded working memory.
 * Each retry opens a fresh, empty sink and creates a fresh transform.
 * Progress is per attempt: bytes are committed plaintext; receivedBytes include
 * skipped HTTP 200 range prefixes and discarded final response bytes.
 */
export async function requestToSink(url, {
  createSink, signal, range, fetchImpl = fetch, retries = 3, onRetry,
  onProgress, maxBytes = Infinity, transformFactory, onResponse,
} = {}) {
  url = httpUrl(url);
  checkRange(range);
  if (typeof createSink !== 'function') throw permanent(new Error('缺少本地文件写入接口'));
  if (!(maxBytes >= 0)) throw permanent(new Error('文件大小限制无效'));
  const retryLimit = Math.max(0, Math.min(10, Number.isInteger(retries) ? retries : 3));

  for (let attempt = 0; attempt <= retryLimit; attempt++) {
    signal?.throwIfAborted();
    const requestController = new AbortController();
    let timer;
    let response;
    let bodyReader;
    let outputReader;
    let source;
    let sink;
    let bytes = 0;
    let receivedBytes = 0;
    let timeoutError;
    let cancellingBody;
    const cancelBody = reason => {
      if (!cancellingBody) cancellingBody = (async () => {
        if (bodyReader) await bodyReader.cancel(reason).catch(() => {});
        else await response?.body?.cancel(reason).catch(() => {});
      })();
      return cancellingBody;
    };
    const aborted = () => {
      requestController.abort(signal.reason);
      void cancelBody(signal.reason);
    };
    const armTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timeoutError = new Error('网络请求超时');
        requestController.abort(timeoutError);
        void cancelBody(timeoutError);
      }, IDLE_TIMEOUT_MS);
    };
    const checkAbort = () => {
      signal?.throwIfAborted();
      if (timeoutError) throw Object.assign(timeoutError, { retryable: true });
    };
    const network = async operation => {
      armTimer();
      try {
        const result = await operation();
        checkAbort();
        return result;
      } catch (error) {
        checkAbort();
        const result = error instanceof Error ? error : new Error(String(error));
        result.retryable = true;
        throw result;
      } finally { clearTimeout(timer); }
    };
    const progress = async () => {
      if (onProgress) await onProgress({ bytes, receivedBytes });
    };
    signal?.addEventListener('abort', aborted, { once: true });

    try {
      try { sink = await createSink(); }
      catch (error) { throw diskError(error); }
      checkAbort();
      let transform;
      if (transformFactory) {
        try { transform = await transformFactory(); }
        catch (error) { throw permanent(error); }
      }
      response = await network(() => fetchImpl(url, {
        credentials: 'include', signal: requestController.signal,
        headers: range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {},
      }));
      if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403
          ? `访问被网站拒绝（${response.status}）。请确认已登录、视频可以播放，或重新检测以更新过期链接。`
          : `下载失败：HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw error;
      }
      const finalUrl = httpUrl(response.url || url);
      if (onResponse) {
        try { await onResponse(response); }
        catch (error) { throw permanent(error); }
      }
      if (!response.body?.getReader) throw permanent(new Error('服务器没有返回可下载的视频内容'));
      if (range && response.status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get('content-range') || '');
        if (!match || Number(match[1]) !== range.offset || Number(match[2]) !== range.offset + range.length - 1
          || (match[3] !== '*' && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= Number(match[2])))) {
          throw permanent(new Error('服务器返回的分段字节范围不正确'));
        }
      } else if (range && response.status !== 200) {
        throw permanent(new Error('服务器返回的分段字节范围不正确'));
      }
      if (!range && !transform && Number(response.headers.get('content-length')) > maxBytes) {
        throw permanent(new Error('资源超过允许的大小'));
      }
      bodyReader = response.body.getReader();
      const start = range && response.status === 200 ? range.offset : 0;
      const end = range ? start + range.length : Infinity;
      let pending = null;
      let pendingOffset = 0;
      let sourceDone = false;

      source = new ReadableStream({
        async pull(controller) {
          checkAbort();
          if (pending && pendingOffset < pending.byteLength) {
            const next = Math.min(pending.byteLength, pendingOffset + CHUNK_BYTES);
            controller.enqueue(pending.subarray(pendingOffset, next));
            pendingOffset = next;
            if (next === pending.byteLength) pending = null;
            return;
          }
          if (sourceDone) { controller.close(); return; }
          while (true) {
            const result = await network(() => bodyReader.read());
            if (result.done) {
              clearTimeout(timer);
              sourceDone = true;
              if (range && receivedBytes < end) throw permanent(new Error('分段字节范围超出文件大小'));
              controller.close();
              return;
            }
            const value = result.value;
            const previous = receivedBytes;
            receivedBytes += value.byteLength;
            if (!Number.isSafeInteger(receivedBytes)) throw permanent(new Error('资源大小超出浏览器支持的范围'));
            if (range && response.status === 206 && receivedBytes > range.length) {
              throw permanent(new Error('服务器返回的分段字节范围不正确'));
            }
            const selectedStart = Math.max(0, start - previous);
            const selectedEnd = Math.min(value.byteLength, end - previous);
            if (range && response.status === 200 && receivedBytes >= end) {
              sourceDone = true;
              clearTimeout(timer);
              await cancelBody();
            }
            await progress();
            if (selectedEnd > selectedStart) {
              pending = value.subarray(selectedStart, selectedEnd);
              const next = Math.min(pending.byteLength, CHUNK_BYTES);
              controller.enqueue(pending.subarray(0, next));
              pendingOffset = next;
              if (next === pending.byteLength) pending = null;
              return;
            }
            if (sourceDone) { controller.close(); return; }
          }
        },
        cancel: reason => cancelBody(reason),
      }, { highWaterMark: 0 });
      const output = transform ? source.pipeThrough(transform) : source;
      outputReader = output.getReader();
      while (true) {
        const { done, value } = await outputReader.read();
        checkAbort();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw permanent(new Error('视频数据转换结果无效'));
        if (bytes + value.byteLength > maxBytes) throw permanent(new Error('资源超过允许的大小'));
        try { await sink.write(value); }
        catch (error) { throw diskError(error); }
        bytes += value.byteLength;
        if (!Number.isSafeInteger(bytes)) throw permanent(new Error('资源大小超出浏览器支持的范围'));
        await progress();
      }
      checkAbort();
      try { await sink.close(); }
      catch (error) { throw diskError(error); }
      checkAbort();
      return { bytes, url: finalUrl };
    } catch (error) {
      const failed = signal?.aborted ? signal.reason : error;
      await outputReader?.cancel(failed).catch(() => {});
      await cancelBody(failed);
      try { await sink?.abort(failed); } catch { /* Preserve the original failure. */ }
      if (signal?.aborted || failed?.permanent || !failed?.retryable || attempt === retryLimit) throw failed;
      if (onRetry) await onRetry({ attempt: attempt + 1, error: failed });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      await cancelBody();
      try { outputReader?.releaseLock(); } catch { /* Already released or aborted. */ }
      try { bodyReader?.releaseLock(); } catch { /* Already released or aborted. */ }
    }
    await pause(500 * (attempt + 1), signal);
  }
}

/**
 * Incremental AES-CBC decryption with WebCrypto and bounded 1 MiB blocks.
 * WebCrypto always validates PKCS#7. For nonfinal blocks, append a separately
 * encrypted padding block so decrypt() returns every actual plaintext byte.
 * The final ciphertext block retains its original padding and is validated.
 */
export function createAesCbcDecryptTransform(key, iv) {
  if (key?.algorithm?.name !== 'AES-CBC' || !key.usages?.includes('encrypt') || !key.usages?.includes('decrypt')) {
    throw permanent(new Error('AES-128 流式密钥需要 encrypt 和 decrypt 权限'));
  }
  let previous;
  try { previous = new Uint8Array(iv).slice(); }
  catch { throw permanent(new Error('AES-128 的 IV 无效')); }
  if (previous.byteLength !== 16) throw permanent(new Error('AES-128 的 IV 必须是 16 字节'));
  const buffer = new Uint8Array(CHUNK_BYTES + 16);
  let buffered = 0;
  const failed = error => permanent(new Error(`AES-128 分段解密失败，请重新检测视频链接。${error?.message ? ` ${error.message}` : ''}`));

  return new TransformStream({
    async transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) throw permanent(new Error('AES-128 密文数据无效'));
      let offset = 0;
      try {
        while (offset < chunk.byteLength) {
          const length = Math.min(buffer.length - buffered, chunk.byteLength - offset);
          buffer.set(chunk.subarray(offset, offset + length), buffered);
          buffered += length;
          offset += length;
          if (buffered === buffer.length) {
            const lastCipher = buffer.slice(CHUNK_BYTES - 16, CHUNK_BYTES);
            const padding = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: lastCipher }, key, new Uint8Array()));
            const padded = new Uint8Array(CHUNK_BYTES + 16);
            padded.set(buffer.subarray(0, CHUNK_BYTES));
            padded.set(padding, CHUNK_BYTES);
            const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: previous }, key, padded);
            controller.enqueue(new Uint8Array(plaintext));
            previous = lastCipher;
            buffer.copyWithin(0, CHUNK_BYTES, buffered);
            buffered = 16;
          }
        }
      } catch (error) { throw failed(error); }
    },
    async flush(controller) {
      if (!buffered || buffered % 16 !== 0) throw permanent(new Error('AES-128 密文长度无效'));
      try {
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: previous }, key, buffer.subarray(0, buffered));
        if (plaintext.byteLength) controller.enqueue(new Uint8Array(plaintext));
      } catch (error) { throw failed(error); }
    },
  });
}
