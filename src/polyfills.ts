// src/polyfills.ts
import { Buffer } from "buffer";

// Solana web3 / spl-token expect Buffer in browser
(globalThis as any).Buffer ??= Buffer;

// Some deps still reference `global`
(globalThis as any).global ??= globalThis;
