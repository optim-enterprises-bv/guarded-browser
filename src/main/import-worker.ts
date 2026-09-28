// Worker thread: parse a Netscape bookmark file off the main thread (a slow or hostile file can
// never freeze the windows or the confirmation timers). The result is re-validated by the store.
import { parentPort, workerData } from 'node:worker_threads';
import { parseNetscape } from '../core/bookmarks';

try {
  parentPort!.postMessage({ ok: true, parsed: parseNetscape(String((workerData as { html: string }).html)) });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message.slice(0, 300) });
}
