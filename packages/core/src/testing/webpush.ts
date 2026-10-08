import { fromBase64Url, toBase64Url } from "../crypto.js";
import { pushKeys } from "../push.js";

/** A pretend browser for Web Push tests: it subscribes, and decrypts what the hub sends it. */
export class TestPushReceiver {
  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly publicKey: Uint8Array<ArrayBuffer>,
    private readonly auth: Uint8Array<ArrayBuffer>,
    readonly endpoint: string,
  ) {}

  static async create(endpoint: string) {
    const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const publicKey = new Uint8Array(
      (await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer,
    );
    return new TestPushReceiver(
      keys,
      publicKey,
      crypto.getRandomValues(new Uint8Array(16)),
      endpoint,
    );
  }

  /** What `JSON.stringify(pushSubscription)` gives in a browser. */
  toJSON() {
    return {
      endpoint: this.endpoint,
      keys: { p256dh: toBase64Url(this.publicKey), auth: toBase64Url(this.auth) },
    };
  }

  /** Decrypts an aes128gcm body (RFC 8291) back to the JSON payload. */
  async decrypt(body: Uint8Array<ArrayBuffer>): Promise<unknown> {
    const salt = body.slice(0, 16);
    const keyLength = body[20] ?? 0;
    const senderKey = body.slice(21, 21 + keyLength);
    const ciphertext = body.slice(21 + keyLength);
    const sender = await crypto.subtle.importKey(
      "raw",
      senderKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const ecdhSecret = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, this.keys.privateKey, 256),
    );
    const { contentKey, nonce } = await pushKeys(
      this.auth,
      ecdhSecret,
      this.publicKey,
      senderKey,
      salt,
    );
    const key = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext),
    );
    // Strip the record delimiter (0x02) and any zero padding after it.
    let end = plain.length - 1;
    while (end > 0 && plain[end] === 0) end--;
    return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
  }
}

/** Checks a VAPID `Authorization` header's ES256 signature and returns its claims. */
export async function verifyVapid(header: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  if (!match) throw new Error(`Not a VAPID header: ${header}`);
  const [header64 = "", claims64 = "", signature64 = ""] = (match[1] ?? "").split(".");
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(match[2] ?? ""),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    fromBase64Url(signature64),
    new TextEncoder().encode(`${header64}.${claims64}`),
  );
  return {
    valid,
    publicKey: match[2],
    claims: JSON.parse(new TextDecoder().decode(fromBase64Url(claims64))) as {
      aud: string;
      exp: number;
      sub: string;
    },
  };
}
