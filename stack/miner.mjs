#!/usr/bin/env node
/**
 * A block producer for the local mirror. It does the one job a consensus client does here: ask ethrex to build a block,
 * and tell it to accept that block, once per slot.
 *
 * ethrex's own `--dev` producer still calls forkchoiceUpdatedV4, which refuses Hegota payload attributes, and a real
 * consensus client refuses a genesis with Hegota already active. So Hegota at block 0 needs this: FCUv5, getPayloadV6,
 * newPayloadV6. Nothing here touches execution. Every block is built and validated by the real client.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const ENGINE = process.env.ENGINE_URL ?? "http://127.0.0.1:8551";
const SECRET = Buffer.from(readFileSync(process.env.JWT_FILE ?? new URL("./jwt.hex", import.meta.url), "utf8").trim().replace(/^0x/, ""), "hex");
const SLOT_MS = Number(process.env.SLOT_MS ?? 2000);
const COINBASE = process.env.COINBASE ?? "0x5544596212F91984C986A919C8026DF0576816f9";
const ZERO = `0x${"00".repeat(32)}`;
/** Sets the block gas target the node builds towards: the devnet's, so that gas behaves the same here. */
const TARGET_GAS = process.env.TARGET_GAS ?? "0x3938700";

const b64 = (value) => Buffer.from(value).toString("base64url");
function jwt() {
  const body = `${b64('{"alg":"HS256","typ":"JWT"}')}.${b64(JSON.stringify({ iat: Math.floor(Date.now() / 1000) }))}`;
  return `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;
}

let id = 1;
async function engine(method, params) {
  const response = await fetch(ENGINE, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt()}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (n) => `0x${n.toString(16)}`;

async function head() {
  const url = process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
  });
  return (await response.json()).result;
}

async function main() {
  let block = await head();
  let parent = block.hash;
  let slot = Number(block.slotNumber ?? 0);
  let time = Number(block.timestamp);
  console.log(`miner: from block ${Number(block.number)}, slot time ${SLOT_MS}ms`);
  for (;;) {
    const started = Date.now();
    try {
      slot += 1;
      // A block's time has to pass its parent's. The genesis file says 0 or so, so the wall clock wins from block 1.
      time = Math.max(time + 1, Math.floor(Date.now() / 1000));
      const state = { headBlockHash: parent, safeBlockHash: parent, finalizedBlockHash: parent };
      const update = await engine("engine_forkchoiceUpdatedV5", [
        state,
        {
          timestamp: hex(time),
          prevRandao: ZERO,
          suggestedFeeRecipient: COINBASE,
          withdrawals: [],
          parentBeaconBlockRoot: ZERO,
          slotNumber: hex(slot),
          inclusionListTransactions: [],
          targetGasLimit: TARGET_GAS,
        },
      ]);
      if (!update.payloadId) throw new Error(`no payload id: ${JSON.stringify(update.payloadStatus)}`);
      await sleep(Math.min(SLOT_MS / 2, 1000));
      const built = await engine("engine_getPayloadV6", [update.payloadId]);
      const payload = built.executionPayload;
      const status = await engine("engine_newPayloadV6", [payload, [], ZERO, built.executionRequests ?? [], []]);
      if (status.status !== "VALID") throw new Error(`payload ${status.status}: ${status.validationError ?? ""}`);
      await engine("engine_forkchoiceUpdatedV5", [{ headBlockHash: payload.blockHash, safeBlockHash: payload.blockHash, finalizedBlockHash: payload.blockHash }, null]);
      parent = payload.blockHash;
      const count = payload.transactions.length;
      if (count > 0 || process.env.MINER_VERBOSE) console.log(`miner: block ${Number(payload.blockNumber)} with ${count} transactions`);
    } catch (error) {
      console.error(`miner: ${error.message}`);
      await sleep(1000);
    }
    await sleep(Math.max(0, SLOT_MS - (Date.now() - started)));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
