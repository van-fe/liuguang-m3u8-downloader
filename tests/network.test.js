import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { requestToSink, createAesCbcDecryptTransform } from '../extension/lib/network.js';

const url = 'https://video.example/resource';

function response(body, { status = 200, headers = {}, redirectedUrl = url } = {}) {
  const result = new Response(body, { status, headers });
  Object.defineProperty(result, 'url', { value: redirectedUrl });
  return result;
}

function memorySink() {
  const attempts = [];
  return {
    attempts,
    createSink: async () => {
      const state = { parts: [], closed: false, aborted: false };
      attempts.push(state);
      return {
        async write(bytes) { state.parts.push(bytes.slice()); },
        async close() { state.closed = true; },
        async abort() { state.aborted = true; },
      };
    },
    bytes: (index = attempts.length - 1) => new Uint8Array(Buffer.concat(attempts[index].parts)),
  };
}

function chunked(bytes, sizes = [1, 7, 13, 31, 65539]) {
  let offset = 0;
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + sizes[index++ % sizes.length]);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

test('streaming plain resources writes incrementally and reports redirect/progress', async () => {
  const sink = memorySink();
  const events = [];
  const input = Uint8Array.from({ length: 257 }, (_, index) => index);
  const result = await requestToSink(url, {
    createSink: sink.createSink,
    onProgress: progress => events.push(progress),
    fetchImpl: async (requestUrl, options) => {
      assert.equal(requestUrl, url);
      assert.equal(options.credentials, 'include');
      return response(chunked(input), { redirectedUrl: 'https://cdn.example/final.ts' });
    },
  });
  assert.deepEqual(sink.bytes(), input);
  assert.equal(result.bytes, 257);
  assert.equal(result.url, 'https://cdn.example/final.ts');
  assert.equal(sink.attempts[0].closed, true);
  assert.equal(sink.attempts[0].aborted, false);
  assert.deepEqual(events.at(-1), { bytes: 257, receivedBytes: 257 });
  assert.ok(sink.attempts[0].parts.length > 1);
});

test('a reused 1 MiB chunk streams past 4 GiB without allocating the resource', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const chunks = 4097;
  let produced = 0;
  let retained = 0;
  let writes = 0;
  let maxWrite = 0;
  const result = await requestToSink(url, {
    createSink: async () => ({
      write: async bytes => { retained += bytes.byteLength; writes++; maxWrite = Math.max(maxWrite, bytes.byteLength); },
      close: async () => {}, abort: async () => {},
    }),
    fetchImpl: async () => response(new ReadableStream({
      pull(controller) {
        if (produced++ < chunks) controller.enqueue(chunk);
        else controller.close();
      },
    }), { headers: { 'Content-Length': String(chunks * chunk.length) } }),
  });
  assert.equal(result.bytes, chunks * chunk.length);
  assert.ok(result.bytes > 2 ** 32);
  assert.equal(retained, result.bytes);
  assert.equal(writes, chunks);
  assert.equal(maxWrite, chunk.length);
});

test('206 byte ranges preserve offsets beyond the 32-bit boundary', async () => {
  const sink = memorySink();
  const offset = 2 ** 32 + 123;
  const result = await requestToSink(url, {
    createSink: sink.createSink, range: { offset, length: 3 },
    fetchImpl: async (_, options) => {
      assert.equal(options.headers.Range, `bytes=${offset}-${offset + 2}`);
      return response(Uint8Array.of(3, 4, 5), {
        status: 206, headers: { 'Content-Range': `bytes ${offset}-${offset + 2}/${offset + 100}` },
      });
    },
  });
  assert.equal(result.bytes, 3);
  assert.deepEqual([...sink.bytes()], [3, 4, 5]);
});

test('200 byte-range fallback skips data and cancels after requested bytes without reading the whole file', async () => {
  const sink = memorySink();
  let reads = 0;
  let cancelled = false;
  const progress = [];
  const result = await requestToSink(url, {
    createSink: sink.createSink, range: { offset: 5, length: 3 },
    onProgress: item => progress.push(item),
    fetchImpl: async () => response(new ReadableStream({
      pull(controller) { controller.enqueue(Uint8Array.from({ length: 4 }, (_, index) => reads * 4 + index)); reads++; },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Length': String(7 * 1024 ** 3) } }),
  });
  assert.deepEqual([...sink.bytes()], [5, 6, 7]);
  assert.equal(result.bytes, 3);
  assert.ok(reads <= 3, 'reader should cancel after the selected range, allowing one stream-prefetched chunk');
  assert.equal(cancelled, true);
  assert.equal(progress.at(-1).receivedBytes, 8);
});

test('range validation rejects missing/wrong headers, short and overlong partial responses permanently', async () => {
  for (const [body, options] of [
    [Uint8Array.of(1, 2, 3), { status: 206, headers: {} }],
    [Uint8Array.of(1, 2, 3), { status: 206, headers: { 'Content-Range': 'bytes 1-3/10' } }],
    [Uint8Array.of(1, 2), { status: 206, headers: { 'Content-Range': 'bytes 2-4/10' } }],
    [Uint8Array.of(1, 2, 3, 4), { status: 206, headers: { 'Content-Range': 'bytes 2-4/10' } }],
    [Uint8Array.of(1, 2), { status: 200, headers: {} }],
    [Uint8Array.of(1, 2, 3), { status: 206, headers: { 'Content-Range': 'bytes 2-4/4' } }],
  ]) {
    let attempts = 0;
    const sink = memorySink();
    await assert.rejects(requestToSink(url, {
      createSink: sink.createSink, range: { offset: 2, length: 3 }, retries: 3,
      fetchImpl: async () => { attempts++; return response(body, options); },
    }), /字节范围/);
    assert.equal(attempts, 1);
    assert.equal(sink.attempts[0].aborted, true);
  }
});

test('network retries replace partial disk files and reset progress per attempt', async () => {
  const sink = memorySink();
  let attempts = 0;
  const retries = [];
  const result = await requestToSink(url, {
    createSink: sink.createSink, retries: 1,
    onRetry: item => retries.push(item.attempt),
    fetchImpl: async () => {
      if (++attempts === 1) {
        let reads = 0;
        return response(new ReadableStream({
          pull(controller) {
            if (reads++ === 0) controller.enqueue(Uint8Array.of(99));
            else controller.error(new TypeError('connection reset'));
          },
        }, { highWaterMark: 0 }));
      }
      return response(Uint8Array.of(1, 2, 3));
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(retries, [1]);
  assert.equal(sink.attempts[0].aborted, true);
  assert.equal(sink.attempts[1].closed, true);
  assert.deepEqual([...sink.bytes()], [1, 2, 3]);
  assert.equal(result.bytes, 3);
});

test('transient HTTP errors retry while disk failures and permanent HTTP errors do not', async () => {
  const sink = memorySink();
  let calls = 0;
  await requestToSink(url, {
    createSink: sink.createSink, retries: 1,
    fetchImpl: async () => ++calls === 1 ? response('busy', { status: 503 }) : response(Uint8Array.of(1)),
  });
  assert.equal(calls, 2);
  for (const status of [400, 401, 403, 404, 410]) {
    calls = 0;
    await assert.rejects(requestToSink(url, {
      createSink: memorySink().createSink, retries: 1,
      fetchImpl: async () => { calls++; return response('denied', { status }); },
    }), new RegExp(String(status)));
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(requestToSink(url, {
    createSink: async () => ({ write: async () => { throw new DOMException('quota full', 'QuotaExceededError'); }, abort: async () => {}, close: async () => {} }),
    retries: 3,
    fetchImpl: async () => { calls++; return response(Uint8Array.of(1)); },
  }), /磁盘空间不足/);
  assert.equal(calls, 1);
});

test('cancellation stops a stalled body and aborts its sink without retrying', async () => {
  const sink = memorySink();
  const controller = new AbortController();
  const reason = new DOMException('用户取消', 'AbortError');
  let cancelled = false;
  let requests = 0;
  const pending = requestToSink(url, {
    createSink: sink.createSink, signal: controller.signal,
    fetchImpl: async () => {
      requests++;
      return response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }));
    },
  });
  setTimeout(() => controller.abort(reason), 10);
  await assert.rejects(pending, error => error === reason);
  assert.equal(requests, 1);
  assert.equal(cancelled, true);
  assert.equal(sink.attempts[0].aborted, true);
});

test('cancellation awaits an already-started async body cancellation and unlocks the reader', async () => {
  const sink = memorySink();
  const controller = new AbortController();
  const reason = new DOMException('用户取消', 'AbortError');
  let body;
  let cancellationFinished = false;
  const pending = requestToSink(url, {
    createSink: sink.createSink, signal: controller.signal,
    fetchImpl: async () => {
      body = new ReadableStream({
        pull() {},
        async cancel() {
          await new Promise(resolve => setTimeout(resolve, 15));
          cancellationFinished = true;
        },
      });
      return response(body);
    },
  });
  setTimeout(() => controller.abort(reason), 5);
  await assert.rejects(pending, error => error === reason);
  assert.equal(cancellationFinished, true);
  assert.equal(body.locked, false);
  assert.equal(sink.attempts[0].aborted, true);
});

test('network idle timeout excludes slow disk writes, close and progress callbacks', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let writes = 0;
  const result = await requestToSink(url, {
    createSink: async () => ({
      async write() { writes++; context.mock.timers.tick(45001); },
      async close() { context.mock.timers.tick(45001); },
      async abort() { assert.fail('slow disk must not abort the resource'); },
    }),
    onProgress: () => context.mock.timers.tick(45001),
    fetchImpl: async () => response(Uint8Array.of(1, 2, 3)),
  });
  assert.equal(result.bytes, 3);
  assert.equal(writes, 1);
});

test('cancellation during a slow sink close still rejects instead of reporting success', async () => {
  const controller = new AbortController();
  const reason = new DOMException('用户取消', 'AbortError');
  let aborted = false;
  await assert.rejects(requestToSink(url, {
    signal: controller.signal,
    createSink: async () => ({
      write: async () => {},
      async close() {
        setTimeout(() => controller.abort(reason), 1);
        await new Promise(resolve => setTimeout(resolve, 5));
      },
      abort: async () => { aborted = true; },
    }),
    fetchImpl: async () => response(Uint8Array.of(1)),
  }), error => error === reason);
  assert.equal(aborted, true);
});

test('plaintext size limits apply after range slicing and terminate streams before excess writes', async () => {
  const sink = memorySink();
  await requestToSink(url, {
    createSink: sink.createSink, range: { offset: 5, length: 3 }, maxBytes: 3,
    fetchImpl: async () => response(Uint8Array.from({ length: 100 }, (_, index) => index), { headers: { 'Content-Length': '100' } }),
  });
  assert.deepEqual([...sink.bytes()], [5, 6, 7]);
  const limited = memorySink();
  await assert.rejects(requestToSink(url, {
    createSink: limited.createSink, maxBytes: 3,
    fetchImpl: async () => response(Uint8Array.of(0, 1, 2, 3)),
  }), /允许的大小/);
  assert.equal(limited.attempts[0].aborted, true);
  assert.equal(limited.bytes().length, 0);
});

test('AES-CBC handles irregular chunk boundaries, empty plaintext and multiple bounded blocks', async () => {
  const key = await webcrypto.subtle.importKey('raw', new Uint8Array(16).fill(7), 'AES-CBC', false, ['encrypt', 'decrypt']);
  const iv = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  for (const length of [0, 1, 15, 16, 17, 31, 32, 33, 2 * 1024 * 1024 + 31]) {
    const plaintext = Uint8Array.from({ length }, (_, index) => index % 251);
    const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext));
    const sink = memorySink();
    const result = await requestToSink(url, {
      createSink: sink.createSink,
      transformFactory: () => createAesCbcDecryptTransform(key, iv),
      fetchImpl: async () => response(chunked(encrypted)),
    });
    assert.deepEqual(sink.bytes(), plaintext);
    assert.equal(result.bytes, plaintext.length);
    assert.ok(sink.attempts[0].parts.every(part => part.length <= 1024 * 1024));
  }
});

test('AES transform state is recreated when a partial encrypted response is retried', async () => {
  const key = await webcrypto.subtle.importKey('raw', new Uint8Array(16).fill(2), 'AES-CBC', false, ['encrypt', 'decrypt']);
  const iv = new Uint8Array(16).fill(9);
  const plaintext = new Uint8Array(1024 * 1024 + 53).fill(11);
  const encrypted = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext));
  const sink = memorySink();
  let attempts = 0;
  let transforms = 0;
  await requestToSink(url, {
    createSink: sink.createSink, retries: 1,
    transformFactory: () => { transforms++; return createAesCbcDecryptTransform(key, iv); },
    fetchImpl: async () => {
      if (++attempts === 1) {
        let reads = 0;
        return response(new ReadableStream({
          pull(controller) {
            if (reads++ === 0) controller.enqueue(encrypted.subarray(0, 1024 * 1024 + 16));
            else controller.error(new TypeError('connection reset'));
          },
        }, { highWaterMark: 0 }));
      }
      return response(chunked(encrypted));
    },
  });
  assert.equal(transforms, 2);
  assert.equal(sink.attempts[0].aborted, true);
  assert.deepEqual(sink.bytes(), plaintext);
});

test('invalid AES padding and truncated ciphertext fail permanently', async () => {
  const key = await webcrypto.subtle.importKey('raw', new Uint8Array(16), 'AES-CBC', false, ['encrypt', 'decrypt']);
  const iv = new Uint8Array(16);
  for (const ciphertext of [new Uint8Array(), Uint8Array.of(1, 2, 3), new Uint8Array(16)]) {
    const sink = memorySink();
    let requests = 0;
    await assert.rejects(requestToSink(url, {
      createSink: sink.createSink, retries: 3,
      transformFactory: () => createAesCbcDecryptTransform(key, iv),
      fetchImpl: async () => { requests++; return response(ciphertext); },
    }), /AES-128/);
    assert.equal(requests, 1);
    assert.equal(sink.attempts[0].aborted, true);
  }
});
