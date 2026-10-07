import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export const DIAGNOSTIC_LIMITS = Object.freeze({
  bodyBytes: 8 * 1024 * 1024, recordBytes: 16 * 1024,
  pendingRecords: 128, pendingBytes: 256 * 1024,
  sessions: 64, attempts: 128, fileBytes: 1024 * 1024, files: 2,
});

/** Only already-projected, content-free records belong here. Includes in-flight IO in caps. */
export class BoundedDiagnosticSink {
  private queue: string[] = [];
  private bytes = 0;
  private running = false;
  private dropped = 0;
  private oversized = 0;
  private failures = 0;
  private waiters: (() => void)[] = [];
  constructor(private writer: (line: string) => Promise<void>) {}
  stats() { return { pendingRecords: this.queue.length, pendingBytes: this.bytes, dropped: this.dropped, oversized: this.oversized, failures: this.failures }; }
  enqueue(record: object): void {
    try {
      const line = JSON.stringify({ ...record, sink: this.stats() }) + "\n";
      const bytes = Buffer.byteLength(line);
      if (bytes > DIAGNOSTIC_LIMITS.recordBytes) { this.oversized++; this.dropped++; return; }
      if (this.queue.length >= DIAGNOSTIC_LIMITS.pendingRecords || this.bytes + bytes > DIAGNOSTIC_LIMITS.pendingBytes) { this.dropped++; return; }
      this.queue.push(line); this.bytes += bytes;
      if (!this.running) void this.drain();
    } catch { this.failures++; }
  }
  private async drain() {
    this.running = true;
    while (this.queue.length) {
      const line = this.queue[0];
      try { await this.writer(line); } catch { this.failures++; }
      this.queue.shift(); this.bytes -= Buffer.byteLength(line);
    }
    this.running = false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  idle(): Promise<void> {
    return this.running ? new Promise(resolve => this.waiters.push(resolve)) : Promise.resolve();
  }
}

/** Serialized by the sink. Refuse symlinks; never write journals or log exception messages. */
export function privateRotatingWriter(directory: string): (line: string) => Promise<void> {
  let ready = false;
  return async line => {
    if (!ready) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const dir = await lstat(directory);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("diagnostic-directory");
      await chmod(directory, 0o700);
      ready = true;
    }
    const current = join(directory, "requests.jsonl");
    const previous = join(directory, "requests.previous.jsonl");
    const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    let file = await open(current, flags, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("diagnostic-file");
      await file.chmod(0o600);
      if (stat.size + Buffer.byteLength(line) > DIAGNOSTIC_LIMITS.fileBytes) {
        await file.close();
        try { await unlink(previous); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await rename(current, previous);
        file = await open(current, flags, 0o600);
        await file.chmod(0o600);
      }
      await file.writeFile(line);
    } finally { await file.close(); }
  };
}
