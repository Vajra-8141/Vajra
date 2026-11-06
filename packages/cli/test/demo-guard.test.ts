/**
 * The demo signer must not exist off the mirror. This starts a bridge configured for the public chain and asks it for every demo
 * route. `mirrorOnly` refuses before any chain call, so this test sends nothing to the public chain.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 18_799;
const url = `http://127.0.0.1:${PORT}`;
let bridge: ChildProcess;

beforeAll(async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, VAJRA_BRIDGE_PORT: String(PORT) };
  delete env.VAJRA_STACK;
  delete env.VAJRA_LANE;
  bridge = spawn("node", ["src/main.ts", "bridge"], { cwd: new URL("..", import.meta.url).pathname, env, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/nothing`).then(() => true, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the bridge did not start");
}, 20_000);

afterAll(() => {
  bridge.kill();
});

describe("on the public chain", () => {
  for (const route of ["/demo/spend", "/demo/thief", "/demo/execute", "/demo/reset", "/attacks/run", "/lab/run", "/lab/race"]) {
    it(`refuses ${route}`, async () => {
      const response = await fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "0x000000000000000000000000000000000000c0de", amount: "1", id: "escape" }) });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("NotOnMirror");
    });
  }

  for (const route of ["/attacks", "/lab"]) {
    it(`does not list ${route}`, async () => {
      expect((await fetch(`${url}${route}`)).status).toBe(403);
    });
  }
});
