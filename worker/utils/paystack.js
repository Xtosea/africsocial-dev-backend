const PAYSTACK_BASE_URL = "https://api.paystack.co";

/**
 * Make an authenticated request to Paystack.
 *
 * IMPORTANT:
 * PAYSTACK_SECRET_KEY must exist as a Cloudflare Worker secret.
 * Never put the secret key in frontend code or source files.
 */
export async function paystackRequest(
  env,
  endpoint,
  options = {}
) {
  if (!env.PAYSTACK_SECRET_KEY) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is not configured"
    );
  }

  const response = await fetch(
    `${PAYSTACK_BASE_URL}${endpoint}`,
    {
      ...options,
      signal:
        options.signal || AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  let data;

  try {
    data = await response.json();
  } catch {
    throw new Error(
      `Paystack returned an invalid response (${response.status}).`
    );
  }

  if (!response.ok || data?.status !== true) {
    const message =
      data?.message ||
      `Paystack request failed (${response.status}).`;

    const error = new Error(message);
    error.paystackStatus = response.status;
    error.paystackResponse = data;

    throw error;
  }

  return data;
}

/**
 * Initialize a Paystack transaction.
 *
 * Amount must be supplied in the smallest currency unit.
 * For NGN:
 * ₦5,000 = 500000 kobo.
 */
export async function initializePaystackTransaction(
  env,
  {
    email,
    amount,
    currency = "NGN",
    reference,
    callbackUrl,
    channels,
    metadata,
  }
) {
  return paystackRequest(
    env,
    "/transaction/initialize",
    {
      method: "POST",
      body: JSON.stringify({
        email,
        amount,
        currency,
        reference,
        ...(callbackUrl
          ? { callback_url: callbackUrl }
          : {}),
        ...(Array.isArray(channels) && channels.length
          ? { channels }
          : {}),
        ...(metadata
          ? { metadata }
          : {}),
      }),
    }
  );
}

/**
 * Verify a Paystack transaction.
 */
export async function verifyPaystackTransaction(
  env,
  reference
) {
  if (!reference) {
    throw new Error(
      "Paystack transaction reference is required."
    );
  }

  return paystackRequest(
    env,
    `/transaction/verify/${encodeURIComponent(reference)}`
  );
}
