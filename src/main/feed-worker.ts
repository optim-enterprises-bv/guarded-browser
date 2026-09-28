// Worker thread: parse one cached feed file into a compact HostSet and hand back its parts.
// Running this off the main thread keeps startup responsive and lets the ~100 MB of parse garbage
// die with the worker instead of inflating the main process.
import { parentPort, workerData } from 'node:worker_threads';
import { inProcessBuilder, type FeedFormat } from '../core/reputation';

const { file, format } = workerData as { file: string; format: FeedFormat };
void inProcessBuilder(file, format).then(
  ({ set, count }) => {
    const { data, offs } = set.parts();
    parentPort!.postMessage({ data, offs, count }, [offs.buffer as ArrayBuffer]);
  },
  (e: Error) => parentPort!.postMessage({ error: e.message }),
);
