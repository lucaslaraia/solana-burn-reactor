// src/App.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getMint,
  createBurnInstruction,
} from "@solana/spl-token";

import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  type Commitment,
  type BlockhashWithExpiryBlockHeight,
  type Message,
  type Connection,
} from "@solana/web3.js";

/* =========================
 * Config (frontend-only)
 * =========================
 * You can override via Vite env:
 * - VITE_FEE_RECEIVER=<PUBKEY>
 * - VITE_FEE_SOL=0.003
 */
const DEFAULT_FEE_RECEIVER = "b9gmEiA4D16bHqcW1SinTDEhBnYF8d4fn7GxEzcrvEc";
const DEFAULT_FEE_SOL = "0.003";

// Security / trust: pin receiver in production to prevent env/phishing builds.
const PINNED_FEE_RECEIVER_PROD = "b9gmEiA4D16bHqcW1SinTDEhBnYF8d4fn7GxEzcrvEc";

// localStorage proof
const LS_PROOF_KEY = "sbr_last_proof_v1";
const PROOF_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Safety: SystemProgram.transfer expects `number` lamports.
const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMALS_SORT_CLAMP_MAX = 18;

/**
 * Safe env reader for Vite.
 * Works in dev + build, avoids destructuring pitfalls.
 */
function envStr(name: string): string | undefined {
  const env = (import.meta as any).env ?? {};
  const v = env[name];
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : undefined;
  }
  return undefined;
}

// Strict SOL string -> lamports bigint (no float)
function solToLamportsBigint(amountSolStr: string): bigint {
  const s = (amountSolStr ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid SOL amount: ${amountSolStr}`);
  const [wholeStr, fracRaw = ""] = s.split(".");
  if (fracRaw.length > 9) throw new Error(`Too many decimals for SOL (max 9): ${amountSolStr}`);
  const whole = BigInt(wholeStr || "0");
  const frac = BigInt((fracRaw || "").padEnd(9, "0") || "0");
  return whole * BigInt(LAMPORTS_PER_SOL) + frac;
}

// Strict SOL string -> lamports number (safe int)
function solToLamportsNumber(amountSolStr: string): number {
  const lamports = solToLamportsBigint(amountSolStr);
  if (lamports <= 0n) throw new Error("Product fee must be > 0.");
  if (lamports > MAX_SAFE_LAMPORTS) {
    throw new Error(
      `Product fee too large for SystemProgram.transfer (lamports > MAX_SAFE_INTEGER). feeLamports=${lamports.toString()}`
    );
  }
  return Number(lamports);
}

function shortAddress(a: string) {
  if (!a) return "";
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/**
 * Prevent leaking secrets (e.g. ?api-key=...) by never displaying queries/hashes.
 * Shows host only (best for trust + safety).
 */
function safeRpcLabel(endpoint: string): string {
  const raw = (endpoint ?? "").trim();
  if (!raw) return "unknown";
  try {
    const u = new URL(raw);
    return u.host || "unknown";
  } catch {
    const noQuery = raw.split("?")[0].split("#")[0];
    try {
      const u2 = new URL(noQuery);
      return u2.host || noQuery;
    } catch {
      return noQuery;
    }
  }
}

type TokenRow = {
  program: "SPL" | "2022";
  mint: string;
  tokenAccount: string;
  amountUi: string;
  amountRaw: string;
  decimals: number; // display only; burn uses mint decimals on-chain
};

// Minimal proof for localStorage (privacy by default)
type BurnProof = {
  signature: string;
  explorerUrl: string;
  clusterClass: "devnet" | "mainnet" | "testnet" | "local" | "unknown";
  mintShort: string;
  amountUi: string;
  pctOfSupplyMicro: string;
  timestampMs: number;
};

function normalizeUiAmountString(v: unknown): string {
  if (v && typeof (v as any).uiAmountString === "string") return (v as any).uiAmountString;
  if (v && typeof (v as any).uiAmount === "number") return String((v as any).uiAmount);
  if (v && typeof (v as any).amount === "string") return (v as any).amount;
  return "0";
}
function safeRawAmountString(v: unknown): string {
  if (v && typeof (v as any).amount === "string") return (v as any).amount;
  return "0";
}
function safeDecimals(v: unknown): number {
  const d = Number((v as any)?.decimals ?? 0);
  return Number.isFinite(d) && d >= 0 ? d : 0;
}
function isNonZeroRaw(amountRaw: string): boolean {
  try {
    return BigInt(String(amountRaw).trim() || "0") > 0n;
  } catch {
    return false;
  }
}
function clampDecimalsForSort(d: number): number {
  if (!Number.isFinite(d) || d < 0) return 0;
  return Math.min(d, DECIMALS_SORT_CLAMP_MAX);
}
function cmpTokenAmountDesc(a: TokenRow, b: TokenRow): number {
  const da = clampDecimalsForSort(a.decimals);
  const db = clampDecimalsForSort(b.decimals);
  const maxD = Math.max(da, db);
  const scaleA = maxD - da;
  const scaleB = maxD - db;

  let A = 0n;
  let B = 0n;
  try {
    A = BigInt(a.amountRaw) * 10n ** BigInt(scaleA);
  } catch {
    A = 0n;
  }
  try {
    B = BigInt(b.amountRaw) * 10n ** BigInt(scaleB);
  } catch {
    B = 0n;
  }

  if (A === B) return 0;
  return A > B ? -1 : 1;
}

async function fetchParsedTokens(owner: PublicKey, connection: Connection): Promise<TokenRow[]> {
  const queries: Array<{ program: "SPL" | "2022"; programId: PublicKey }> = [
    { program: "SPL", programId: TOKEN_PROGRAM_ID },
    { program: "2022", programId: TOKEN_2022_PROGRAM_ID },
  ];

  const results = await Promise.all(
    queries.map(async (q) => {
      const res = await connection.getParsedTokenAccountsByOwner(owner, { programId: q.programId });
      const rows: TokenRow[] = [];
      for (const { pubkey, account } of res.value) {
        const info = (account?.data as any)?.parsed?.info;
        if (!info) continue;

        const mint = String(info.mint ?? "");
        const tokenAmount = info.tokenAmount ?? {};

        const decimals = safeDecimals(tokenAmount);
        const amountRaw = safeRawAmountString(tokenAmount);
        if (!isNonZeroRaw(amountRaw)) continue;

        const amountUi = normalizeUiAmountString(tokenAmount);

        rows.push({
          program: q.program,
          mint,
          tokenAccount: pubkey.toBase58(),
          amountUi,
          amountRaw,
          decimals,
        });
      }
      return rows;
    })
  );

  const out = results.flat();
  out.sort(cmpTokenAmountDesc);
  return out;
}

// UI amount -> raw bigint (strict, no truncation)
function uiToRaw(amountUiStr: string, decimals: number): bigint {
  const s = (amountUiStr ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${amountUiStr}`);

  const [wholeStr, fracRaw = ""] = s.split(".");
  if (fracRaw.length > decimals) {
    throw new Error(`Too many decimals (max ${decimals}). Got: ${amountUiStr}`);
  }

  const frac = fracRaw.padEnd(decimals, "0");
  const whole = BigInt(wholeStr || "0");
  const fracPart = BigInt(frac || "0");
  const base = 10n ** BigInt(decimals);
  const raw = whole * base + fracPart;

  if (raw <= 0n) throw new Error(`Amount must be > 0. Got: ${amountUiStr}`);
  return raw;
}

function rawToUi(raw: bigint, decimals: number): string {
  if (decimals <= 0) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr.length ? `${whole.toString()}.${fracStr}` : whole.toString();
}

/**
 * lamports bigint -> SOL string without Number() precision loss
 */
function lamportsBigintToSolString(lamports: bigint, fracDigits = 6): string {
  const neg = lamports < 0n;
  const v = neg ? -lamports : lamports;

  const base = 1_000_000_000n; // 1 SOL
  const whole = v / base;
  const frac = v % base;

  const fracStrFull = frac.toString().padStart(9, "0");
  const d = Math.max(0, Math.min(9, fracDigits));
  const fracStr = fracStrFull.slice(0, d).replace(/0+$/, "");

  return `${neg ? "-" : ""}${whole.toString()}${fracStr.length ? "." + fracStr : ""}`;
}

/**
 * Classify by declared env cluster first; fallback to endpoint heuristics.
 * Avoids "unknown" for paid/private RPCs.
 */
function classifyCluster(
  endpoint: string,
  envCluster: string | undefined
): "devnet" | "mainnet" | "testnet" | "local" | "unknown" {
  const ec = (envCluster ?? "").trim().toLowerCase();
  if (ec === "devnet") return "devnet";
  if (ec === "testnet") return "testnet";
  if (ec === "mainnet-beta" || ec === "mainnet") return "mainnet";

  const e = (endpoint ?? "").toLowerCase();
  if (!e) return "unknown";
  if (e.includes("127.0.0.1") || e.includes("localhost")) return "local";
  if (e.includes("devnet")) return "devnet";
  if (e.includes("testnet")) return "testnet";
  if (e.includes("mainnet") || e.includes("api.solana.com")) return "mainnet";
  return "unknown";
}

function explorerTxUrl(signature: string, clusterClass: ReturnType<typeof classifyCluster>): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  if (clusterClass === "devnet") return `${base}?cluster=devnet`;
  if (clusterClass === "testnet") return `${base}?cluster=testnet`;
  if (clusterClass === "mainnet") return base;
  return base;
}

function isBlockhashExpiry(e: any): boolean {
  const msg = String(e?.message ?? e).toLowerCase();
  return msg.includes("block height exceeded") || msg.includes("blockhash not found") || msg.includes("expired");
}

function isUserRejected(e: any): boolean {
  const msg = String(e?.message ?? e).toLowerCase();
  return (
    msg.includes("user rejected") ||
    msg.includes("user declined") ||
    msg.includes("rejected the request") ||
    msg.includes("declined the request")
  );
}

function classifySendError(e: any): { summary: string; details?: string } {
  const raw = String(e?.message ?? e);
  const low = raw.toLowerCase();

  if (isUserRejected(e)) return { summary: "Signature request rejected by user.", details: raw };
  if (low.includes("insufficient funds") || low.includes("insufficient lamports") || low.includes("insufficient sol")) {
    return { summary: "Insufficient SOL for network fees + product fee.", details: raw };
  }
  if (isBlockhashExpiry(e)) {
    return { summary: "Blockhash expired (slow/unstable RPC). Please retry.", details: raw };
  }
  if (low.includes("simulation failed") || low.includes("sendtransaction")) {
    const logs = Array.isArray((e as any)?.logs) ? (e as any).logs.join("\n") : undefined;
    const details = logs ? `${raw}\n\nLogs:\n${logs}` : raw;
    return { summary: "Preflight/simulation failed (see details).", details };
  }
  return { summary: raw, details: raw };
}

async function detectTokenProgramId(connection: Connection, mint: PublicKey, commitment: Commitment): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, commitment);
  if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`);

  const owner = info.owner;
  if (owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;

  throw new Error(`Mint owner is not Token/Token-2022: owner=${owner.toBase58()}`);
}

async function estimateNetworkFeeLamports(
  connection: Connection,
  tx: Transaction,
  commitment: Commitment
): Promise<number | null> {
  try {
    const msg = tx.compileMessage() as Message;
    const fee = await (connection as any).getFeeForMessage(msg, commitment);
    const val = fee?.value;
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) return val;
    return null;
  } catch {
    return null;
  }
}

// Percent in micro-% (1e-6 %) as bigint
function calcPctOfSupplyMicro(amountRaw: bigint, supplyRaw: bigint): bigint {
  if (supplyRaw <= 0n) return 0n;
  return (amountRaw * 100_000_000n) / supplyRaw; // amount * (100 * 1e6) / supply
}

function formatMicroPercent(pctMicro: bigint): string {
  const sign = pctMicro < 0n ? "-" : "";
  const v = pctMicro < 0n ? -pctMicro : pctMicro;
  const whole = v / 1_000_000n;
  const frac = v % 1_000_000n;
  const frac4 = (frac / 100n).toString().padStart(4, "0"); // 4 decimals
  return `${sign}${whole.toString()}.${frac4}%`;
}

function safeParseProof(raw: string | null): BurnProof | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") return null;
    if (typeof (j as any).signature !== "string" || (j as any).signature.length < 20) return null;
    if (typeof (j as any).timestampMs !== "number") return null;
    if (Date.now() - (j as any).timestampMs > PROOF_TTL_MS) return null;
    return j as BurnProof;
  } catch {
    return null;
  }
}

export default function App() {
  const { connection } = useConnection();
  const { publicKey, connected, sendTransaction } = useWallet();

  const commitment: Commitment = "confirmed";
  const isProd = Boolean((import.meta as any).env?.PROD);

  const feeReceiverPk = useMemo(() => {
    const raw = isProd ? PINNED_FEE_RECEIVER_PROD : envStr("VITE_FEE_RECEIVER") || DEFAULT_FEE_RECEIVER;
    return new PublicKey(raw);
  }, [isProd]);

  const feeLamportsProductNumber = useMemo(() => {
    const raw = envStr("VITE_FEE_SOL") || DEFAULT_FEE_SOL;
    return solToLamportsNumber(raw);
  }, []);

  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [err, setErr] = useState<string>("");

  const [solLamports, setSolLamports] = useState<number | null>(null);
  const [solErr, setSolErr] = useState<string>("");

  const [clusterInfo, setClusterInfo] = useState<{
    endpoint: string;
    genesisHash?: string;
    clusterClass?: ReturnType<typeof classifyCluster>;
  } | null>(null);
  const [clusterErr, setClusterErr] = useState<string>("");

  const [networkFeeLamportsEst, setNetworkFeeLamportsEst] = useState<number | null>(null);
  const [feeEstErr, setFeeEstErr] = useState<string>("");

  const [selectedKey, setSelectedKey] = useState<string>("");
  const selectedRow = useMemo(() => {
    if (!selectedKey) return null;
    return rows.find((r) => `${r.program}:${r.tokenAccount}` === selectedKey) ?? null;
  }, [rows, selectedKey]);

  const rowsRef = useRef<TokenRow[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const [burnAll, setBurnAll] = useState(false);
  const [burnAmountUi, setBurnAmountUi] = useState<string>("");

  const [latchChecked, setLatchChecked] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const [isRunning, setIsRunning] = useState(false);
  const [step, setStep] = useState<"idle" | "sign" | "confirm">("idle");

  const [lastProof, setLastProof] = useState<BurnProof | null>(null);
  const [shareMsg, setShareMsg] = useState<string>("");
  const [copyOk, setCopyOk] = useState<string>("");

  const [runErr, setRunErr] = useState<string>("");
  const [runErrDetails, setRunErrDetails] = useState<string>("");

  const runLockRef = useRef(false);

  const address = useMemo(() => publicKey?.toBase58() ?? "", [publicKey]);

  const mintCacheRef = useRef<Map<string, { programId: PublicKey; decimals: number }>>(new Map());
  const envCluster = useMemo(() => envStr("VITE_SOLANA_CLUSTER"), []);

  useEffect(() => {
    const p = safeParseProof(localStorage.getItem(LS_PROOF_KEY));
    if (p) {
      setLastProof(p);
      setShareMsg(buildShareMessage(p));
    } else {
      localStorage.removeItem(LS_PROOF_KEY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!lastProof) {
      localStorage.removeItem(LS_PROOF_KEY);
      return;
    }
    try {
      localStorage.setItem(LS_PROOF_KEY, JSON.stringify(lastProof));
    } catch {
      // ignore
    }
  }, [lastProof]);

  function buildShareMessage(p: BurnProof): string {
    const pct = formatMicroPercent(BigInt(p.pctOfSupplyMicro || "0"));
    const amt = p.amountUi;
    const clusterTag = p.clusterClass === "mainnet" ? "mainnet" : p.clusterClass;
    return (
      `🔥 Burned ${amt} (${pct} of supply)\n` +
      `Mint: ${p.mintShort}\n` +
      `Tx: ${p.explorerUrl}\n` +
      `via Solana Burn Reactor · ${clusterTag}`
    );
  }

  const loadTokens = useCallback(async () => {
    if (!publicKey) return;
    setErr("");
    setLoading(true);
    try {
      const data = await fetchParsedTokens(publicKey, connection as Connection);
      setRows(data);

      if (selectedKey) {
        const still = data.some((r) => `${r.program}:${r.tokenAccount}` === selectedKey);
        if (!still) setSelectedKey("");
      }
    } catch (e: any) {
      setErr(e?.message ?? String(e));
      setRows([]);
      setSelectedKey("");
    } finally {
      setLoading(false);
    }
  }, [publicKey, connection, selectedKey]);

  useEffect(() => {
    (async () => {
      if (!publicKey) {
        setSolLamports(null);
        setSolErr("");
        return;
      }
      try {
        setSolErr("");
        const lamports = await (connection as Connection).getBalance(publicKey);
        setSolLamports(lamports);
      } catch (e: any) {
        setSolErr(e?.message ?? String(e));
        setSolLamports(null);
      }
    })();
  }, [publicKey, connection, isRunning]);

  useEffect(() => {
    (async () => {
      try {
        setClusterErr("");
        const endpoint = (connection as any)?.rpcEndpoint ?? "";
        let genesisHash: string | undefined;
        try {
          genesisHash = await (connection as any).getGenesisHash?.();
        } catch {
          // ignore
        }
        setClusterInfo({
          endpoint,
          genesisHash,
          clusterClass: classifyCluster(endpoint, envCluster),
        });
      } catch (e: any) {
        setClusterErr(e?.message ?? String(e));
        setClusterInfo(null);
      }
    })();
  }, [connection, envCluster]);

  const rpcLabel = useMemo(() => {
    const ep = clusterInfo?.endpoint || "";
    if (!ep) return "unknown";
    return safeRpcLabel(ep);
  }, [clusterInfo?.endpoint]);

  useEffect(() => {
    if (!selectedKey) {
      setBurnAll(false);
      setBurnAmountUi("");
      setLatchChecked(false);
      setConfirmText("");
      setRunErr("");
      setRunErrDetails("");
      setNetworkFeeLamportsEst(null);
      setFeeEstErr("");
      return;
    }

    const row = rowsRef.current.find((r) => `${r.program}:${r.tokenAccount}` === selectedKey) ?? null;
    if (!row) {
      setSelectedKey("");
      return;
    }

    setBurnAll(false);
    setBurnAmountUi(row.amountUi);
    setLatchChecked(false);
    setConfirmText("");
    setRunErr("");
    setRunErrDetails("");
  }, [selectedKey]);

  useEffect(() => {
    if (!selectedRow) return;
    if (burnAll) setBurnAmountUi(selectedRow.amountUi);
  }, [burnAll, selectedRow]);

  const clusterClass = clusterInfo?.clusterClass ?? "unknown";
  const clusterHardBlocked = useMemo(() => clusterClass === "local", [clusterClass]);
  const clusterWarnUnknown = useMemo(() => clusterClass === "unknown", [clusterClass]);

  const feeReceiverMismatch = useMemo(() => {
    if (!isProd) return false;
    try {
      return feeReceiverPk.toBase58() !== PINNED_FEE_RECEIVER_PROD;
    } catch {
      return true;
    }
  }, [isProd, feeReceiverPk]);

  const confirmOk = useMemo(() => confirmText.trim().toUpperCase() === "BURN", [confirmText]);

  // =========================
  // Fee estimate
  // =========================
  useEffect(() => {
    (async () => {
      if (!publicKey || !selectedRow) {
        setNetworkFeeLamportsEst(null);
        setFeeEstErr("");
        return;
      }
      try {
        setFeeEstErr("");

        const latest: BlockhashWithExpiryBlockHeight = await (connection as Connection).getLatestBlockhash(commitment);

        const mintPk = new PublicKey(selectedRow.mint);
        const tokenAccountPk = new PublicKey(selectedRow.tokenAccount);

        // Use real program owner (do not rely on parsed "SPL/2022" hint)
        const programId = await detectTokenProgramId(connection as Connection, mintPk, commitment);

        const ixFee = SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: feeReceiverPk,
          lamports: feeLamportsProductNumber,
        });

        let estBurnAmountRaw = 1n;
        try {
          if (burnAll) {
            const raw = BigInt(String(selectedRow.amountRaw || "0"));
            estBurnAmountRaw = raw > 0n ? raw : 1n;
          } else {
            const s = (burnAmountUi ?? "").trim();
            if (s && /^\d+(\.\d+)?$/.test(s)) {
              const raw = uiToRaw(s, selectedRow.decimals);
              estBurnAmountRaw = raw > 0n ? raw : 1n;
            }
          }
        } catch {
          estBurnAmountRaw = 1n;
        }

        const ixBurn = createBurnInstruction(tokenAccountPk, mintPk, publicKey, estBurnAmountRaw, [], programId);

        const tx = new Transaction().add(ixFee, ixBurn);
        tx.feePayer = publicKey;
        tx.recentBlockhash = latest.blockhash;

        const feeLamports = await estimateNetworkFeeLamports(connection as Connection, tx, commitment);
        setNetworkFeeLamportsEst(feeLamports);
      } catch (e: any) {
        setNetworkFeeLamportsEst(null);
        setFeeEstErr(e?.message ?? String(e));
      }
    })();
  }, [
    publicKey,
    selectedRow,
    connection,
    feeReceiverPk,
    commitment,
    feeLamportsProductNumber,
    burnAll,
    burnAmountUi,
  ]);

  const solUi = useMemo(() => {
    if (solLamports === null) return "";
    return (solLamports / LAMPORTS_PER_SOL).toFixed(4);
  }, [solLamports]);

  const productFeeUi = useMemo(() => {
    return (feeLamportsProductNumber / LAMPORTS_PER_SOL).toFixed(6);
  }, [feeLamportsProductNumber]);

  const netFeeEstUi = useMemo(() => {
    const n = networkFeeLamportsEst ?? 0;
    return (n / LAMPORTS_PER_SOL).toFixed(6);
  }, [networkFeeLamportsEst]);

  const minSolRequiredLamports = useMemo(() => {
    if (networkFeeLamportsEst == null) return null;

    const net = BigInt(networkFeeLamportsEst);
    const margin = BigInt(Math.ceil(Number(net) * 0.25)) + 2_000n;
    return BigInt(feeLamportsProductNumber) + net + margin;
  }, [feeLamportsProductNumber, networkFeeLamportsEst]);

  const minSolRequiredUi = useMemo(() => {
    if (minSolRequiredLamports == null) return "";
    return lamportsBigintToSolString(minSolRequiredLamports, 6);
  }, [minSolRequiredLamports]);

  const solEnoughForRun = useMemo(() => {
    if (solLamports == null) return true;
    if (minSolRequiredLamports == null) return true;
    return BigInt(solLamports) >= minSolRequiredLamports;
  }, [solLamports, minSolRequiredLamports]);

  const canRun = useMemo(() => {
    if (!connected || !publicKey) return false;
    if (!selectedRow) return false;
    if (!latchChecked) return false;
    if (!confirmOk) return false;
    if (isRunning) return false;
    if (clusterHardBlocked) return false;
    if (!solEnoughForRun) return false;
    if (feeReceiverMismatch) return false;

    const s = (burnAmountUi ?? "").trim();
    if (!burnAll) {
      if (!s) return false;
      if (!/^\d+(\.\d+)?$/.test(s)) return false;
      if (s === "0" || s === "0.0" || /^0(\.0+)?$/.test(s)) return false;
    }
    return true;
  }, [
    connected,
    publicKey,
    selectedRow,
    latchChecked,
    confirmOk,
    isRunning,
    clusterHardBlocked,
    solEnoughForRun,
    burnAmountUi,
    burnAll,
    feeReceiverMismatch,
  ]);

  async function resolveMintProgramAndDecimals(mintPk: PublicKey): Promise<{ programId: PublicKey; decimals: number }> {
    const key = mintPk.toBase58();
    const cached = mintCacheRef.current.get(key);
    if (cached) return cached;

    const programId = await detectTokenProgramId(connection as Connection, mintPk, commitment);
    const mintInfo = await getMint(connection as Connection, mintPk, commitment, programId);
    const val = { programId, decimals: mintInfo.decimals };
    mintCacheRef.current.set(key, val);
    return val;
  }

  async function copyToClipboard(text: string) {
    setCopyOk("");
    try {
      await navigator.clipboard.writeText(text);
      setCopyOk("Copied.");
      setTimeout(() => setCopyOk(""), 1200);
    } catch {
      setCopyOk("Copy failed.");
    }
  }

  const onBurn = useCallback(async () => {
    if (!publicKey || !selectedRow) return;

    if (runLockRef.current) return;
    runLockRef.current = true;

    setRunErr("");
    setRunErrDetails("");
    setIsRunning(true);
    setStep("sign");

    const mintPk = new PublicKey(selectedRow.mint);
    const tokenAccountPk = new PublicKey(selectedRow.tokenAccount);

    try {
      const { programId: tokenProgramId, decimals: mintDecimals } = await resolveMintProgramAndDecimals(mintPk);

      const mintBefore = await getMint(connection as Connection, mintPk, commitment, tokenProgramId);
      const supplyBefore = mintBefore.supply;

      const accBefore = await getAccount(connection as Connection, tokenAccountPk, commitment, tokenProgramId);

      if (!accBefore.owner.equals(publicKey)) {
        throw new Error(
          `Blocked: token account is not owned by signer.\nowner=${accBefore.owner.toBase58()}\nsigner=${publicKey.toBase58()}`
        );
      }
      if (!accBefore.mint.equals(mintPk)) {
        throw new Error(
          `Blocked: token account mint mismatch.\naccount.mint=${accBefore.mint.toBase58()}\nexpected=${mintPk.toBase58()}`
        );
      }

      const burnUi = (burnAmountUi ?? "").trim();
      const amountRaw = burnAll ? accBefore.amount : uiToRaw(burnUi, mintDecimals);

      if (amountRaw <= 0n) throw new Error("Amount must be > 0.");
      if (accBefore.amount < amountRaw) {
        throw new Error(
          `Insufficient balance.\n` +
            `balanceUi=${rawToUi(accBefore.amount, mintDecimals)}\n` +
            `amountUi=${burnAll ? rawToUi(amountRaw, mintDecimals) : burnUi}`
        );
      }

      const pctMicro = calcPctOfSupplyMicro(amountRaw, supplyBefore);

      const buildTx = async (): Promise<{ tx: Transaction; latest: BlockhashWithExpiryBlockHeight }> => {
        const latest: BlockhashWithExpiryBlockHeight = await (connection as Connection).getLatestBlockhash(commitment);

        const ixFee = SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: feeReceiverPk,
          lamports: feeLamportsProductNumber,
        });

        const ixBurn = createBurnInstruction(tokenAccountPk, mintPk, publicKey, amountRaw, [], tokenProgramId);

        const tx = new Transaction().add(ixFee, ixBurn);
        tx.feePayer = publicKey;
        tx.recentBlockhash = latest.blockhash;

        // Optional: explicit simulation in dev to avoid wallet prompts when doomed
        if (!isProd) {
          const sim = await (connection as Connection).simulateTransaction(tx);
          if (sim.value.err) {
            const logs = sim.value.logs?.join("\n") ?? "";
            throw new Error(`Simulation failed.\n${logs}`);
          }
        }

        return { tx, latest };
      };

      const sendOnce = async (): Promise<{ sig: string; latest: BlockhashWithExpiryBlockHeight }> => {
        const { tx, latest } = await buildTx();
        const sig = await sendTransaction(tx, connection as Connection, {
          skipPreflight: false,
          preflightCommitment: commitment,
          maxRetries: 3,
        });
        return { sig, latest };
      };

      const confirmOnce = async (sig: string, latest: BlockhashWithExpiryBlockHeight) => {
        await (connection as Connection).confirmTransaction(
          { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
          commitment
        );
      };

      const hasSignatureLanded = async (sig: string): Promise<boolean> => {
        try {
          const st = await (connection as Connection).getSignatureStatuses([sig], { searchTransactionHistory: true });
          const v = st?.value?.[0];
          return !!v; // if there is a status record, it has landed (success or failure)
        } catch {
          return false;
        }
      };

      const first = await sendOnce();
      setStep("confirm");

      let finalSig = first.sig;

      try {
        await confirmOnce(first.sig, first.latest);
      } catch (e: any) {
        if (isBlockhashExpiry(e)) {
          // Prevent double-charging: check whether the original signature already landed before re-sending.
          const landed = await hasSignatureLanded(first.sig);
          if (landed) {
            finalSig = first.sig;
          } else {
            const retry = await sendOnce();
            finalSig = retry.sig;
            await confirmOnce(retry.sig, retry.latest);
          }
        } else {
          throw e;
        }
      }

      const url = explorerTxUrl(finalSig, clusterClass);

      const proof: BurnProof = {
        signature: finalSig,
        explorerUrl: url,
        clusterClass,
        mintShort: shortAddress(mintPk.toBase58()),
        amountUi: rawToUi(amountRaw, mintDecimals),
        pctOfSupplyMicro: pctMicro.toString(),
        timestampMs: Date.now(),
      };

      setLastProof(proof);
      setShareMsg(buildShareMessage(proof));

      await loadTokens();
      setStep("idle");
    } catch (e: any) {
      const ce = classifySendError(e);
      setRunErr(ce.summary);

      // Production: do not show raw error details by default (fingerprinting/noise)
      if (!isProd) setRunErrDetails(ce.details ?? "");
      else setRunErrDetails("");

      setStep("idle");
    } finally {
      setIsRunning(false);
      runLockRef.current = false;
    }
  }, [
    publicKey,
    selectedRow,
    connection,
    sendTransaction,
    commitment,
    feeReceiverPk,
    feeLamportsProductNumber,
    burnAmountUi,
    burnAll,
    loadTokens,
    clusterClass,
    isProd,
  ]);

  const proofPct = useMemo(() => {
    if (!lastProof) return "";
    try {
      return formatMicroPercent(BigInt(lastProof.pctOfSupplyMicro || "0"));
    } catch {
      return "";
    }
  }, [lastProof]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0a0a",
        color: "#eaeaea",
        fontFamily: "Inter, system-ui, sans-serif",
        padding: 24,
      }}
    >
      <div style={{ width: "100%", maxWidth: 920, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <h1 style={{ fontSize: 42, margin: 0 }}>Solana Burn Reactor</h1>

          <p style={{ fontSize: 14, opacity: 0.9, marginTop: 10, lineHeight: 1.35 }}>
            <strong>Strategic token burning for creators and liquidity managers.</strong>
            <br />
            Reduce supply, reshape distribution, and signal on-chain scarcity — safely, in one transaction.
          </p>

          <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
            <WalletMultiButton />
          </div>

          {feeReceiverMismatch ? (
            <div style={{ marginTop: 10, fontSize: 12, color: "#ffb4b4", whiteSpace: "pre-wrap" }}>
              Blocked: unverified build (fee receiver mismatch). Do not proceed.
            </div>
          ) : null}

          {clusterInfo && (
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
              RPC:{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{rpcLabel}</span>
              {clusterInfo.clusterClass ? (
                <>
                  {" · "}Cluster:{" "}
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {clusterInfo.clusterClass}
                  </span>
                </>
              ) : null}
              {clusterInfo.genesisHash ? (
                <>
                  {" · "}Genesis:{" "}
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {shortAddress(clusterInfo.genesisHash)}
                  </span>
                </>
              ) : null}
              {clusterErr ? <span style={{ color: "#ffb4b4" }}> (rpc info error: {clusterErr})</span> : null}
            </div>
          )}

          {clusterHardBlocked ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "#ffb4b4", whiteSpace: "pre-wrap" }}>
              Blocked: RPC points to localnet (localhost/127.0.0.1). Use a devnet/mainnet RPC endpoint.
            </div>
          ) : null}

          {clusterWarnUnknown ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "#ffd7a8", whiteSpace: "pre-wrap" }}>
              Warning: RPC cluster is unknown. If tokens do not load or blockhash expires, your wallet network may not
              match this RPC.
            </div>
          ) : null}

          {connected && (
            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75 }}>
              Connected:{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                {shortAddress(address)}
              </span>
              {" · "}SOL:{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                {solLamports === null ? "…" : solUi}
              </span>
              {solErr ? <span style={{ color: "#ffb4b4" }}> (balance error: {solErr})</span> : null}
              {" · "}Fee:{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{productFeeUi} SOL</span>
              {" · "}Receiver:{" "}
              <span
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                title={feeReceiverPk.toBase58()}
              >
                {shortAddress(feeReceiverPk.toBase58())}
              </span>
              {networkFeeLamportsEst != null ? (
                <>
                  {" · "}Net fee est:{" "}
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{netFeeEstUi} SOL</span>
                  {" · "}Min SOL:{" "}
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {minSolRequiredUi} SOL
                  </span>
                </>
              ) : null}
              {feeEstErr ? <span style={{ color: "#ffb4b4" }}> (fee est error: {feeEstErr})</span> : null}
              {!solEnoughForRun ? <span style={{ color: "#ffb4b4" }}> (insufficient SOL)</span> : null}
            </div>
          )}

          {lastProof ? (
            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.95 }}>
              Proof:{" "}
              <a
                href={lastProof.explorerUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  color: "#16f195",
                  textDecoration: "none",
                }}
              >
                {lastProof.signature}
              </a>
              {" · "}Burned:{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                {lastProof.amountUi}
              </span>
              {" · "}Of supply:{" "}
              <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{proofPct || "—"}</span>

              <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => copyToClipboard(shareMsg)}
                  disabled={isRunning || !shareMsg}
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    fontWeight: 900,
                    background: isRunning ? "rgba(255,255,255,0.08)" : "rgba(22,241,149,0.18)",
                    color: "#eaeaea",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 8,
                    cursor: isRunning ? "not-allowed" : "pointer",
                  }}
                >
                  Copy share
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setLastProof(null);
                    setShareMsg("");
                    setCopyOk("");
                  }}
                  disabled={isRunning}
                  style={{
                    padding: "6px 10px",
                    fontSize: 12,
                    fontWeight: 800,
                    background: isRunning ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.14)",
                    color: "#eaeaea",
                    border: "1px solid rgba(255,255,255,0.12)",
                    borderRadius: 8,
                    cursor: isRunning ? "not-allowed" : "pointer",
                  }}
                >
                  Clear proof
                </button>

                {copyOk ? <span style={{ fontSize: 12, opacity: 0.85 }}>{copyOk}</span> : null}
              </div>

              {shareMsg ? (
                <details style={{ marginTop: 10, maxWidth: 680, marginLeft: "auto", marginRight: "auto" }}>
                  <summary style={{ cursor: "pointer", opacity: 0.9 }}>share preview</summary>
                  <pre style={{ whiteSpace: "pre-wrap", marginTop: 8, opacity: 0.95 }}>{shareMsg}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* INVENTORY */}
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.10)",
            borderRadius: 12,
            background: "rgba(255,255,255,0.03)",
            padding: 14,
            marginBottom: 14,
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 10,
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
            }}
          >
            <div>
              <div style={{ fontWeight: 700 }}>Token Inventory</div>
              <div style={{ fontSize: 12, opacity: 0.65 }}>Load is read-only. No SOL spent.</div>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                type="button"
                disabled={!selectedKey || isRunning}
                onClick={() => setSelectedKey("")}
                style={{
                  padding: "10px 12px",
                  fontSize: 13,
                  fontWeight: 700,
                  background: !selectedKey || isRunning ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.16)",
                  color: "#eaeaea",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 8,
                  cursor: !selectedKey || isRunning ? "not-allowed" : "pointer",
                }}
              >
                Clear selection
              </button>

              <button
                type="button"
                disabled={!connected || loading || isRunning}
                onClick={loadTokens}
                style={{
                  padding: "10px 14px",
                  fontSize: 14,
                  fontWeight: 700,
                  background: !connected || loading || isRunning ? "rgba(22,241,149,0.25)" : "#16f195",
                  color: "#000",
                  border: "none",
                  borderRadius: 8,
                  cursor: !connected || loading || isRunning ? "not-allowed" : "pointer",
                }}
              >
                {loading ? "Loading…" : "Load Tokens"}
              </button>
            </div>
          </div>

          {err && <div style={{ marginTop: 12, fontSize: 12, color: "#ffb4b4" }}>Error: {err}</div>}

          <div style={{ marginTop: 12 }}>
            {rows.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.7 }}>
                {connected ? "No non-zero token accounts found. Normal if you only have SOL." : "Connect wallet first."}
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ textAlign: "left", opacity: 0.75 }}>
                      <th style={{ padding: "8px 6px" }}>Pick</th>
                      <th style={{ padding: "8px 6px" }}>Program</th>
                      <th style={{ padding: "8px 6px" }}>Mint</th>
                      <th style={{ padding: "8px 6px" }}>Token Account</th>
                      <th style={{ padding: "8px 6px" }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const key = `${r.program}:${r.tokenAccount}`;
                      const checked = key === selectedKey;
                      return (
                        <tr key={key} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                          <td style={{ padding: "8px 6px" }}>
                            <input
                              type="radio"
                              name="pick-token"
                              checked={checked}
                              disabled={isRunning}
                              onChange={() => setSelectedKey(key)}
                            />
                          </td>
                          <td style={{ padding: "8px 6px", opacity: 0.9 }}>{r.program}</td>
                          <td
                            style={{ padding: "8px 6px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                            title={r.mint}
                          >
                            {shortAddress(r.mint)}
                          </td>
                          <td
                            style={{
                              padding: "8px 6px",
                              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                            }}
                            title={r.tokenAccount}
                          >
                            {shortAddress(r.tokenAccount)}
                          </td>
                          <td style={{ padding: "8px 6px" }}>
                            {r.amountUi} <span style={{ opacity: 0.6 }}>({r.decimals}d)</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.55 }}>
                  Sorted by value. Zeros filtered by raw amount.
                </div>
              </div>
            )}
          </div>
        </div>

        {/* BURN */}
        <div
          style={{
            border: "1px solid rgba(255,255,255,0.10)",
            borderRadius: 12,
            background: "rgba(255,255,255,0.03)",
            padding: 14,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 800, fontSize: 16 }}>Burn</div>
              <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
                One click = one on-chain transaction (fee + burn). One signature.
              </div>
            </div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{isRunning ? `step: ${step}` : ""}</div>
          </div>

          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Mint</div>
              <div
                style={{
                  padding: "10px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(0,0,0,0.30)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  opacity: selectedRow ? 1 : 0.6,
                }}
              >
                {selectedRow ? selectedRow.mint : "Select a token above"}
              </div>
            </div>

            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Token Account</div>
              <div
                style={{
                  padding: "10px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(0,0,0,0.30)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  fontSize: 12,
                  opacity: selectedRow ? 1 : 0.6,
                }}
              >
                {selectedRow ? selectedRow.tokenAccount : "—"}
              </div>
            </div>

            <div style={{ fontSize: 12, opacity: 0.8 }}>
              Balance:{" "}
              {selectedRow ? (
                <>
                  {selectedRow.amountUi} <span style={{ opacity: 0.6 }}>({selectedRow.decimals}d)</span>
                </>
              ) : (
                "—"
              )}
            </div>

            <div style={{ display: "grid", gap: 6, maxWidth: 320 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Amount (UI)</div>
              <input
                value={burnAmountUi}
                disabled={!selectedRow || isRunning || burnAll}
                onChange={(e) => setBurnAmountUi(e.target.value)}
                placeholder="e.g. 1.25"
                autoComplete="off"
                style={{
                  padding: "10px 10px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.12)",
                  background: "rgba(0,0,0,0.35)",
                  color: "#eaeaea",
                  outline: "none",
                  fontSize: 14,
                }}
              />
            </div>

            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, marginTop: 2 }}>
              <input
                type="checkbox"
                checked={burnAll}
                disabled={!selectedRow || isRunning}
                onChange={(e) => setBurnAll(e.target.checked)}
              />
              Burn ALL
            </label>

            <div style={{ marginTop: 6, display: "grid", gap: 10 }}>
              <div style={{ fontWeight: 800 }}>Irreversible latch</div>

              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={latchChecked}
                  disabled={!selectedRow || isRunning}
                  onChange={(e) => setLatchChecked(e.target.checked)}
                />
                I understand this burn is irreversible.
              </label>

              <div style={{ display: "grid", gap: 6, maxWidth: 240 }}>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Type</div>
                <input
                  value={confirmText}
                  disabled={!selectedRow || isRunning}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder='Type "BURN"'
                  autoComplete="off"
                  style={{
                    padding: "10px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.12)",
                    background: "rgba(0,0,0,0.35)",
                    color: "#eaeaea",
                    outline: "none",
                    fontSize: 14,
                  }}
                />
              </div>

              <button
                type="button"
                disabled={!canRun}
                onClick={onBurn}
                style={{
                  padding: "12px 14px",
                  fontSize: 14,
                  fontWeight: 900,
                  background: canRun ? "#ff4d4d" : "rgba(255,77,77,0.25)",
                  color: "#000",
                  border: "none",
                  borderRadius: 10,
                  cursor: canRun ? "pointer" : "not-allowed",
                  maxWidth: 260,
                }}
              >
                {isRunning ? "Processing…" : "BURN"}
              </button>

              <div style={{ fontSize: 12, opacity: 0.75, whiteSpace: "pre-wrap" }}>
                Fee: {productFeeUi} SOL + network fee (~{netFeeEstUi} SOL). Fee+burn are atomic and charged when the
                transaction is confirmed on-chain.
              </div>

              {!solEnoughForRun && connected ? (
                <div style={{ fontSize: 12, color: "#ffb4b4", whiteSpace: "pre-wrap" }}>
                  Blocked: insufficient SOL for product fee + network fees. Need at least ~{minSolRequiredUi} SOL.
                </div>
              ) : null}

              {runErr ? (
                <div style={{ fontSize: 12, color: "#ffb4b4", whiteSpace: "pre-wrap" }}>
                  Error: {runErr}
                  {runErrDetails && !isProd && (
                    <details style={{ marginTop: 8, opacity: 0.9 }}>
                      <summary style={{ cursor: "pointer" }}>details</summary>
                      <pre style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>{runErrDetails}</pre>
                    </details>
                  )}
                </div>
              ) : null}

              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.55 }}>
                If you see "block height exceeded", the RPC was slow. This app can retry once when safe.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
