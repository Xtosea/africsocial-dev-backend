const encoder = new TextEncoder();

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid media token");
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);

  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function getSigningKey(secret, usage) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("Media token signing secret is unavailable");
  }

  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage
  );
}

export async function createMediaAccessToken({
  secret,
  key,
  viewerId,
  ttlSeconds = 300,
}) {
  if (
    typeof key !== "string" ||
    !key ||
    typeof viewerId !== "string" ||
    !/^[a-f\d]{24}$/i.test(viewerId)
  ) {
    throw new Error("Invalid media token parameters");
  }

  const ttl = Math.min(Math.max(Number(ttlSeconds) || 300, 1), 300);
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    typ: "media",
    sub: viewerId,
    key,
    iat: now,
    exp: now + ttl,
  };

  const encodedPayload = encodeBase64Url(
    encoder.encode(JSON.stringify(payload))
  );

  const signingKey = await getSigningKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    encoder.encode(encodedPayload)
  );

  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
}

export async function verifyMediaAccessToken({
  token,
  secret,
  key,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  try {
    if (
      typeof token !== "string" ||
      typeof key !== "string" ||
      !key
    ) {
      return null;
    }

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [encodedPayload, encodedSignature] = parts;
    const payloadBytes = decodeBase64Url(encodedPayload);
    const signatureBytes = decodeBase64Url(encodedSignature);

    const signingKey = await getSigningKey(secret, ["verify"]);
    const validSignature = await crypto.subtle.verify(
      "HMAC",
      signingKey,
      signatureBytes,
      encoder.encode(encodedPayload)
    );

    if (!validSignature) return null;

    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));

    if (
      payload.typ !== "media" ||
      payload.key !== key ||
      typeof payload.sub !== "string" ||
      !/^[a-f\d]{24}$/i.test(payload.sub) ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.iat > nowSeconds + 30 ||
      payload.exp <= nowSeconds ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 300
    ) {
      return null;
    }

    return {
      viewerId: payload.sub,
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}
