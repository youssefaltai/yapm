import { badRequest } from "./errors.js";

const encoder = new TextEncoder();

export function newId(): string {
  return crypto.randomUUID();
}

/** A random URL-safe token with the given prefix, e.g. `los_…`. */
export function randomToken(prefix: string, bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return `${prefix}${toBase64Url(buf)}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The AES-GCM key for sign-ins the hub keeps, derived from `YAPM_SECRET`. */
async function secretKey(secret: string | undefined) {
  if (!secret) throw badRequest("Set YAPM_SECRET on the hub before storing sign-ins");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypts `value` as `<iv>.<ciphertext>`. */
export async function seal(secret: string | undefined, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await secretKey(secret),
    encoder.encode(value),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(data))}`;
}

export async function open(secret: string | undefined, sealed: string): Promise<string> {
  const [iv = "", data = ""] = sealed.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv) },
    await secretKey(secret),
    fromBase64Url(data),
  );
  return new TextDecoder().decode(plain);
}
