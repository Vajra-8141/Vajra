/**
 * One master operation at a time, across every process on this machine.
 *
 * The bridge, the Telegram watcher and the phone service can each ask for a signature. Two of them reading the same `nextLeaf` and
 * signing different digests would reveal one leaf twice, which lets anyone forge a third signature. So the leaf is taken inside
 * this lock. The lock is a file created with O_EXCL. A process that died holding it leaves its pid, and that is how a stale lock
 * is told from a live one.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { keyPath } from "./deploy.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const lockPath = () => keyPath("signer.lock");

function holderIsGone(path: string): boolean {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function tryLock(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}

/** Waits for the lock. A chain transaction can take minutes when the node cancels and it is rebroadcast, so the patience is long. */
export async function withSignerLock<T>(work: () => Promise<T>, patienceMs = 300_000): Promise<T> {
  const path = lockPath();
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + patienceMs;
  while (!tryLock(path)) {
    if (holderIsGone(path)) rmSync(path, { force: true });
    else if (Date.now() > deadline) throw new Error("another master operation has held the signer for too long");
    else await sleep(250);
  }
  try {
    return await work();
  } finally {
    rmSync(path, { force: true });
  }
}
