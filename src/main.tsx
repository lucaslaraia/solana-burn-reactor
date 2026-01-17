// src/main.tsx
import "./polyfills";

import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";

import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { clusterApiUrl } from "@solana/web3.js";

import "@solana/wallet-adapter-react-ui/styles.css";

type Cluster = "devnet" | "mainnet-beta" | "testnet";

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

function guessClusterFromEndpoint(endpoint: string): Cluster | "local" | "unknown" {
  const e = (endpoint ?? "").toLowerCase();
  if (!e) return "unknown";
  if (e.includes("127.0.0.1") || e.includes("localhost")) return "local";
  if (e.includes("devnet")) return "devnet";
  if (e.includes("testnet")) return "testnet";
  if (e.includes("mainnet") || e.includes("api.mainnet-beta") || e.includes("api.solana.com")) {
    return "mainnet-beta";
  }
  return "unknown";
}

function isHttps(url: string): boolean {
  return /^https:\/\//i.test(url);
}

function mustAllowCluster(value: string | undefined): value is Cluster {
  return value === "devnet" || value === "testnet" || value === "mainnet-beta";
}

// ---------------------------------------------------------------------
// Cluster + RPC resolution (production hardened)
// ---------------------------------------------------------------------

const isProd = Boolean((import.meta as any).env?.PROD);

// Production safety: never default to devnet.
const rawCluster = envStr("VITE_SOLANA_CLUSTER");
const CLUSTER: Cluster = mustAllowCluster(rawCluster) ? rawCluster : isProd ? "mainnet-beta" : "devnet";

// Production safety: mainnet-only by default.
// If you want to allow testnet/devnet on production builds, set VITE_ALLOW_NON_MAINNET=true explicitly.
const ALLOW_NON_MAINNET = (envStr("VITE_ALLOW_NON_MAINNET") || "").toLowerCase() === "true";
const EFFECTIVE_CLUSTER: Cluster = isProd && !ALLOW_NON_MAINNET ? "mainnet-beta" : CLUSTER;

const DEFAULT_RPC = clusterApiUrl(EFFECTIVE_CLUSTER);
const ENV_RPC = envStr("VITE_SOLANA_RPC");

function resolveEndpoint(): string {
  // No env → official cluster RPC
  if (!ENV_RPC) return DEFAULT_RPC;

  const inferred = guessClusterFromEndpoint(ENV_RPC);

  // Never allow local RPC in wallet apps
  if (inferred === "local") return DEFAULT_RPC;

  // In prod, require https
  if (isProd && !isHttps(ENV_RPC)) return DEFAULT_RPC;

  // If endpoint explicitly declares a cluster and mismatches → block
  if (inferred !== "unknown" && inferred !== EFFECTIVE_CLUSTER) return DEFAULT_RPC;

  // If prod is mainnet-only, do not allow endpoints that clearly indicate non-mainnet.
  if (isProd && !ALLOW_NON_MAINNET && inferred !== "unknown" && inferred !== "mainnet-beta") return DEFAULT_RPC;

  // Paid/private RPCs often look "unknown" → accept
  return ENV_RPC;
}

const endpoint = resolveEndpoint();

// ---------------------------------------------------------------------

// Production safety: autoconnect OFF by default.
const AUTO_CONNECT =
  ((envStr("VITE_WALLET_AUTOCONNECT") || "").toLowerCase() === "true") && !isProd;

function RootProviders() {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect={AUTO_CONNECT}>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootProviders />
  </React.StrictMode>
);
