import { isoCBOR } from "@simplewebauthn/server/helpers";
import { fromBase64Url, toBase64Url } from "../crypto.js";

const encoder = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]);
}

/** WebCrypto returns ECDSA signatures as r||s; WebAuthn expects ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if ((v[0] ?? 0) & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

interface Options {
  challenge: string;
  rp?: { id?: string };
  rpId?: string;
  user?: { id: string };
}

/**
 * A software passkey for tests: produces real WebAuthn registration and
 * authentication responses (ES256, "none" attestation) that the hub verifies
 * exactly as it would a browser's.
 */
export class SoftwareAuthenticator {
  private keys?: CryptoKeyPair;
  private readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  private signCount = 0;
  private userHandle?: string;

  get id(): string {
    return toBase64Url(this.credentialId);
  }

  async register(options: Options, origin: string) {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    this.userHandle = options.user?.id;
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    const coseKey = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, fromBase64Url(jwk.x ?? "")],
      [-3, fromBase64Url(jwk.y ?? "")],
    ]);
    const rpId = options.rp?.id ?? new URL(origin).hostname;
    const authData = concat(
      await sha256(encoder.encode(rpId)),
      new Uint8Array([0x45]), // user present, user verified, attested credential data
      uint32(this.signCount),
      new Uint8Array(16), // AAGUID
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      isoCBOR.encode(coseKey),
    );
    const clientDataJSON = encoder.encode(
      JSON.stringify({
        type: "webauthn.create",
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        attestationObject: toBase64Url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  async authenticate(options: Options, origin: string) {
    if (!this.keys) throw new Error("Register the authenticator first");
    this.signCount += 1;
    const rpId = options.rpId ?? new URL(origin).hostname;
    const authData = concat(
      await sha256(encoder.encode(rpId)),
      new Uint8Array([0x05]),
      uint32(this.signCount),
    );
    const clientDataJSON = encoder.encode(
      JSON.stringify({
        type: "webauthn.get",
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(rawToDer(raw)),
        ...(this.userHandle ? { userHandle: this.userHandle } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}
