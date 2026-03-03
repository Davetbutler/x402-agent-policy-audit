/**
 * Mock HTTP server for x402 demo. Returns 402 Payment Required; when the client
 * retries with PAYMENT-SIGNATURE, settles the EIP-3009 payment on Base Sepolia
 * and returns 200 with the tx hash (if MOCK_402_RELAYER_PRIVATE_KEY is set).
 *
 * Run: npm run demo:mock-402
 * Then in another terminal: npm run demo:x402
 *
 * Set MOCK_402_RELAYER_PRIVATE_KEY in .env (wallet with a little Base Sepolia ETH
 * to pay gas) to enable real on-chain settlement. Otherwise the server always
 * returns 402.
 */

import "dotenv/config";
import { createServer } from "node:http";
import {
  createWalletClient,
  createPublicClient,
  http,
  getAddress,
  parseSignature,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { eip3009ABI } from "@x402/evm";

const PORT = 4020;
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Mock payment: 1000 = 0.001 USDC (6 decimals), well under any test wallet */
const MOCK_PAYMENT_AMOUNT = "1000";

const PAYMENT_REQUIRED_V2 = {
  x402Version: 2,
  resource: {
    url: `http://localhost:${PORT}/paid`,
    description: "Mock paid API - flights",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      asset: BASE_SEPOLIA_USDC,
      amount: MOCK_PAYMENT_AMOUNT,
      payTo: "0x0000000000000000000000000000000000000001",
      maxTimeoutSeconds: 300,
      extra: {
        name: "USDC",
        version: "2",
      },
    },
  ],
  extensions: null,
};

const paymentRequiredHeader = Buffer.from(
  JSON.stringify(PAYMENT_REQUIRED_V2),
  "utf-8"
).toString("base64");

function getPaymentSignatureHeader(
  req: import("node:http").IncomingMessage
): string | null {
  const h = req.headers["payment-signature"] ?? req.headers["PAYMENT-SIGNATURE"];
  return Array.isArray(h) ? h[0] ?? null : h ?? null;
}

async function settleEIP3009(paymentPayload: {
  payload: { authorization: Record<string, string>; signature: string };
  accepted: { asset: string };
}): Promise<{ txHash: string }> {
  const relayerPk = process.env.MOCK_402_RELAYER_PRIVATE_KEY;
  if (!relayerPk?.trim() || !relayerPk.startsWith("0x")) {
    throw new Error(
      "MOCK_402_RELAYER_PRIVATE_KEY not set (0x-prefixed hex). Cannot settle."
    );
  }
  const key = relayerPk.startsWith("0x") ? relayerPk : `0x${relayerPk}`;
  const account = privateKeyToAccount(key as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(),
  });
  const { authorization, signature } = paymentPayload.payload;
  const asset = getAddress(paymentPayload.accepted?.asset ?? BASE_SEPOLIA_USDC);
  const sigHex = signature.startsWith("0x") ? signature : `0x${signature}`;
  const sigLength = sigHex.length - 2;
  const isECDSA = sigLength === 130;
  if (!isECDSA) {
    throw new Error(
      "Only ECDSA signature (65 bytes) supported for settlement."
    );
  }
  const parsed = parseSignature(sigHex as `0x${string}`);
  // FiatTokenV2 ecrecover expects v = 27 or 28; viem may return yParity 0/1
  const v =
    parsed.v !== undefined && (parsed.v === 27n || parsed.v === 28n)
      ? Number(parsed.v)
      : 27 + (parsed.yParity ?? 0);
  const txHash = await walletClient.writeContract({
    address: asset,
    abi: eip3009ABI as readonly unknown[],
    functionName: "transferWithAuthorization",
    args: [
      getAddress(authorization.from),
      getAddress(authorization.to),
      BigInt(authorization.value),
      BigInt(authorization.validAfter),
      BigInt(authorization.validBefore),
      authorization.nonce as `0x${string}`,
      v,
      parsed.r,
      parsed.s,
    ],
  });
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error("Settlement transaction reverted.");
  }
  return { txHash };
}

const server = createServer((req, res) => {
  if (req.url !== "/paid" || req.method !== "GET") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const paymentSig = getPaymentSignatureHeader(req);
  if (!paymentSig) {
    res.writeHead(402, {
      "Content-Type": "application/json",
      "PAYMENT-REQUIRED": paymentRequiredHeader,
    });
    res.end(JSON.stringify({ error: "Payment required" }));
    return;
  }

  (async () => {
    try {
      const raw = Buffer.from(paymentSig, "base64").toString("utf-8");
      const payload = JSON.parse(raw) as {
        payload?: {
          authorization?: Record<string, string>;
          signature?: string;
        };
        accepted?: { asset?: string };
      };
      if (
        !payload?.payload?.authorization ||
        !payload?.payload?.signature ||
        !payload?.accepted
      ) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid payment payload" }));
        return;
      }
      const { txHash } = await settleEIP3009({
        payload: {
          authorization: payload.payload.authorization,
          signature: payload.payload.signature,
        },
        accepted: payload.accepted,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ txHash, message: "Payment received" }));
    } catch (err) {
      console.error("Settlement error:", err);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "Settlement failed",
        })
      );
    }
  })();
});

server.listen(PORT, () => {
  const canSettle =
    process.env.MOCK_402_RELAYER_PRIVATE_KEY?.trim()?.startsWith("0x");
  console.log(`Mock 402 server listening on http://localhost:${PORT}`);
  console.log(
    `GET /paid → 402; retry with PAYMENT-SIGNATURE → ${
      canSettle
        ? "200 + settle on Base Sepolia"
        : "402 (set MOCK_402_RELAYER_PRIVATE_KEY to settle)"
    }.`
  );
});
