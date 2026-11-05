/**
 * The master key's only door to the outside: a local HTTP service with the shape a hardware signer will have.
 *
 * The dashboard asks for an operation by name and gets a transaction hash back. It never sees the seed, and it cannot
 * submit a digest of its own choosing, so a compromised page can ask for a freeze but cannot get a signature over
 * something else. A device goes one step further and shows the operation on a screen before signing; this software
 * stand-in signs what it is asked, which is why it only listens on loopback and only answers one origin.
 */
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { RpcError, refusalName } from "@vajra/core";
import { createWallet, runMasterOp, walletStatus } from "./wallet.ts";

const PORT = Number(process.env.VAJRA_BRIDGE_PORT ?? 8787);
const ORIGIN = process.env.VAJRA_ORIGIN ?? "http://localhost:3000";

const MAX_BODY = 16_384;

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("request too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": ORIGIN, vary: "origin" });
  res.end(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function refusal(error: unknown) {
  const e = error as Error;
  return { error: e.name === "Error" ? "Refused" : e.name, message: error instanceof RpcError ? refusalName(error.message) : e.message };
}

export function startBridge() {
  const server = createServer(async (req, res) => {
    // Any web page can reach localhost. This check, and the preflight a JSON body forces, are what stop one from
    // asking this process to spend the master key.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== ORIGIN) return send(res, 403, { error: "OriginRefused", message: `only ${ORIGIN} may use this bridge` });

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": ORIGIN,
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        vary: "origin",
      });
      return res.end();
    }

    try {
      if (req.method === "GET" && req.url === "/status") return send(res, 200, await walletStatus());
      if (req.method === "POST" && req.url === "/create") return send(res, 200, await createWallet((await body(req)) as never));
      if (req.method === "POST" && req.url === "/master") {
        const request = (await body(req)) as never;
        console.log("master operation requested:", JSON.stringify(request));
        const result = await runMasterOp(request, console.log);
        console.log(`mined ${result.hash}, leaf ${result.leaf}, ${result.leavesLeft} left`);
        return send(res, 200, result);
      }
      return send(res, 404, { error: "NotFound" });
    } catch (error) {
      console.log("refused:", (error as Error).message);
      return send(res, 400, refusal(error));
    }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`bridge on http://127.0.0.1:${PORT}, answering ${ORIGIN}`));
  return server;
}
