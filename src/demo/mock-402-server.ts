/**
 * Mock HTTP server for x402 demo. Returns 402 Payment Required with amount from query.
 * Optional: settles EIP-3009 when PAYMENT-SIGNATURE is sent (set MOCK_402_RELAYER_PRIVATE_KEY).
 *
 * Run: npm run demo:mock-402
 * Then run the agent demo: npm run apl -- demo
 */

import "dotenv/config";
import express from "express";
import { createWalletClient, http, parseAbiItem, parseSignature } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const PORT = Number(process.env.MOCK_402_PORT ?? 4020);
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const RELAYER_PK = process.env.MOCK_402_RELAYER_PRIVATE_KEY;
const CHAIN_ID = 84532; // Base Sepolia

const app = express();
app.use(express.json({ limit: "1mb" }));

app.all("/paid", (req, res) => {
  const amountParam = req.query.amount ?? req.query.cents;
  const amountCents = amountParam ? Math.max(0, Number(amountParam)) : 1000;
  const amount = String(amountCents);

  const url = `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl.split("?")[0]}`;
  const paymentRequired = {
    x402Version: 2,
    resource: {
      url,
      description: "Demo payment",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: USDC_BASE_SEPOLIA,
        amount,
        payTo: relayerAddress(),
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };

  const signature = req.get("payment-signature") ?? req.get("PAYMENT-SIGNATURE");
  if (signature && RELAYER_PK) {
    settleEIP3009(signature, amountCents)
      .then((txHash) => res.status(200).json({ ok: true, txHash }))
      .catch((err) => {
        console.error("Settlement error:", err);
        res.status(502).json({ error: "Settlement failed", message: String(err) });
      });
    return;
  }

  res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(paymentRequired), "utf-8").toString("base64"));
  res.status(402).json(paymentRequired);
});

function relayerAddress(): string {
  if (!RELAYER_PK) return "0x0000000000000000000000000000000000000000";
  const pk = RELAYER_PK.startsWith("0x") ? RELAYER_PK : `0x${RELAYER_PK}`;
  return privateKeyToAccount(pk as `0x${string}`).address;
}

function parsePaymentPayload(raw: unknown): {
  from: string;
  to: string;
  value: string;
  validAfter: string | number;
  validBefore: string | number;
  nonce: string;
  v: number;
  r: string;
  s: string;
} {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!obj) throw new Error("Invalid PAYMENT-SIGNATURE payload: not an object");

  const payload = (obj.payload && typeof obj.payload === "object" ? (obj.payload as Record<string, unknown>) : obj) as Record<string, unknown>;
  const auth = (payload.authorization && typeof payload.authorization === "object" ? payload.authorization : payload) as Record<string, unknown>;

  const from = String(auth.from ?? payload.from ?? "").trim();
  const to = String(auth.to ?? payload.to ?? "").trim();
  const value = auth.value !== undefined ? String(auth.value) : String(payload.value ?? "0");
  const validAfter = auth.validAfter ?? payload.validAfter ?? 0;
  const validBefore = auth.validBefore ?? payload.validBefore ?? 0;
  let nonce = String(auth.nonce ?? payload.nonce ?? "").trim();
  let r = String(auth.r ?? payload.r ?? "").trim();
  let s = String(auth.s ?? payload.s ?? "").trim();
  let v = typeof auth.v === "number" ? auth.v : typeof payload.v === "number" ? payload.v : parseInt(String(auth.v ?? payload.v ?? 0), 16);

  const signatureHex = typeof payload.signature === "string" ? payload.signature.trim() : "";
  if (signatureHex && (!r || !s || r === "0x" || s === "0x")) {
    try {
      const sig = parseSignature(signatureHex as `0x${string}`);
      r = sig.r;
      s = sig.s;
      v = sig.yParity === 0 ? 27 : 28;
    } catch (e) {
      throw new Error("Invalid PAYMENT-SIGNATURE payload: could not parse signature");
    }
  }

  if (!from || !to) throw new Error("Invalid PAYMENT-SIGNATURE payload: missing from or to");
  if (!nonce) throw new Error("Invalid PAYMENT-SIGNATURE payload: missing nonce");
  if (!r || !s || r === "0x" || s === "0x") throw new Error("Invalid PAYMENT-SIGNATURE payload: missing or invalid r/s (need signature or r,s)");

  if (!nonce.startsWith("0x")) nonce = `0x${nonce}`;
  if (nonce.length !== 66) nonce = `0x${nonce.slice(2).padStart(64, "0").slice(-64)}` as string;

  return { from, to, value, validAfter, validBefore, nonce, v, r, s };
}

async function settleEIP3009(signatureHeader: string, _amountCents: number): Promise<string> {
  if (!RELAYER_PK) throw new Error("MOCK_402_RELAYER_PRIVATE_KEY not set");
  const pk = RELAYER_PK.startsWith("0x") ? RELAYER_PK : `0x${RELAYER_PK}`;
  const relayer = privateKeyToAccount(pk as `0x${string}`);

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(signatureHeader, "base64").toString("utf-8"));
  } catch {
    throw new Error("Invalid PAYMENT-SIGNATURE payload: not valid base64 JSON");
  }

  const { from, to, value, validAfter, validBefore, nonce, v, r, s } = parsePaymentPayload(raw);
  let vNorm = typeof v === "number" ? v : parseInt(String(v), 16);
  if (vNorm < 27) vNorm += 27;

  const walletClient = createWalletClient({
    account: relayer,
    chain: baseSepolia,
    transport: http(),
  });

  const valueBn = BigInt(value);
  const validAfterBn = BigInt(validAfter);
  const validBeforeBn = BigInt(validBefore);
  const nonceHex = (nonce.length === 66 ? nonce : `0x${nonce.replace(/^0x/, "").padStart(64, "0").slice(-64)}`) as `0x${string}`;
  const rHex = (r.length === 66 ? r : `0x${r.replace(/^0x/, "").padStart(64, "0").slice(-64)}`) as `0x${string}`;
  const sHex = (s.length === 66 ? s : `0x${s.replace(/^0x/, "").padStart(64, "0").slice(-64)}`) as `0x${string}`;

  const hash = await walletClient.writeContract({
    address: USDC_BASE_SEPOLIA,
    abi: [
      parseAbiItem(
        "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)"
      ),
    ],
    functionName: "transferWithAuthorization",
    args: [
      from as `0x${string}`,
      to as `0x${string}`,
      valueBn,
      validAfterBn,
      validBeforeBn,
      nonceHex,
      vNorm as 27 | 28,
      rHex,
      sHex,
    ],
  });

  return hash;
}

app.listen(PORT, () => {
  console.log(`Mock x402 server at http://localhost:${PORT}`);
  console.log("  GET /paid?amount=<cents> — returns 402 with that amount");
  if (RELAYER_PK) console.log("  EIP-3009 settlement enabled (relayer set)");
});
