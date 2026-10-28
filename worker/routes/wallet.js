import { ObjectId } from "mongodb";

/* ================= WALLET ECONOMY ================= */

const BASE_CURRENCY = "NGN";
const RATE = 0.5;
const MIN_CONVERSION_POINTS = 10000;

const SUPPORTED_CURRENCIES = [
  "NGN",
  "USD",
  "GBP",
  "EUR",
  "CAD",
  "AUD",
  "ZAR",
  "GHS",
  "KES",
];

/* ================= EXCHANGE RATES ================= */

async function getExchangeRates() {
  const cache = caches.default;

  const cacheKey = new Request(
    "https://africsocial-internal/exchange-rates/usd"
  );

  // Try Cloudflare's edge cache first.
  const cachedResponse = await cache.match(cacheKey);

  if (cachedResponse) {
    return await cachedResponse.json();
  }

  const response = await fetch(
    "https://open.er-api.com/v6/latest/USD"
  );

  if (!response.ok) {
    throw new Error(
      `Exchange rate API returned ${response.status}`
    );
  }

  const data = await response.json();

  if (data.result !== "success" || !data.rates) {
    throw new Error(
      "Invalid exchange rate API response"
    );
  }

  const exchangeData = {
    baseCurrency: "USD",
    rates: data.rates,
    lastUpdateUnix: data.time_last_update_unix,
    nextUpdateUnix: data.time_next_update_unix,
  };

  // Cache until the next scheduled rate update.
  const cacheSeconds = data.time_next_update_unix
    ? Math.max(
        3600,
        data.time_next_update_unix -
          Math.floor(Date.now() / 1000)
      )
    : 86400;

  const cacheResponse = new Response(
    JSON.stringify(exchangeData),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${cacheSeconds}`,
      },
    }
  );

  await cache.put(cacheKey, cacheResponse.clone());

  return exchangeData;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function getToken(request) {
  const authorization = request.headers.get("Authorization");

  if (!authorization) {
    return null;
  }

  const parts = authorization.trim().split(/\s+/);

  if (parts.length !== 2 || parts[0] !== "Bearer") {
    return null;
  }

  return parts[1];
}

function base64UrlDecode(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded =
    base64 + "=".repeat((4 - (base64.length % 4)) % 4);

  return atob(padded);
}

async function verifyJWT(token, secret) {
  if (!token) {
    throw new Error("Authentication required");
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    throw new Error("Invalid token");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["verify"]
  );

  const signature = Uint8Array.from(
    base64UrlDecode(encodedSignature),
    char => char.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(
      `${encodedHeader}.${encodedPayload}`
    )
  );

  if (!valid) {
    throw new Error("Invalid token");
  }

  const payload = JSON.parse(
    base64UrlDecode(encodedPayload)
  );

  if (
    payload.exp &&
    payload.exp < Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Token expired");
  }

  return payload;
}

export async function getWallet(request, env, db) {
  try {
    if (!env.JWT_SECRET) {
      return json({
        error: "JWT_SECRET is not configured",
      }, 500);
    }

    const token = getToken(request);

    if (!token) {
      return json({
        error: "Authentication required",
      }, 401);
    }

    const payload = await verifyJWT(
      token,
      env.JWT_SECRET
    );

    if (!payload.id) {
      return json({
        error: "Invalid authentication token",
      }, 401);
    }

    if (!ObjectId.isValid(payload.id)) {
      return json({
        error: "Invalid user ID",
      }, 401);
    }

    const userId = new ObjectId(payload.id);

    const account = await db.collection("users").findOne(
      { _id: userId },
      { projection: { deletionStatus: 1 } }
    );

    if (
      ["requested", "pending", "processing", "review_required"].includes(
        String(account?.deletionStatus || "").toLowerCase()
      )
    ) {
      return json({
        success: false,
        code: "ACCOUNT_DELETION_PENDING",
        error: "Wallet access is disabled while account deletion is pending.",
      }, 403);
    }

    let wallet = await db.collection("wallets").findOne({
      user: userId,
    });

    if (!wallet) {
      wallet = {
        user: userId,
        balance: 0,
        points: 0,
        storyLikes: 0,
        storyViews: 0,
        reelLikes: 0,
        reelViews: 0,
        videoLikes: 0,
        videoViews: 0,
        referralPoints: 0,
        leaderboardPoints: 0,
        lifetimeEarned: 0,
        pending: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await db.collection("wallets").insertOne(wallet);
    }

    // ================= SELECTED DISPLAY CURRENCY =================

    const url = new URL(request.url);

    const currency = String(
      url.searchParams.get("currency") || BASE_CURRENCY
    ).toUpperCase();

    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return json({
        error: `Unsupported currency: ${currency}`,
      }, 400);
    }

    // ================= BASE NGN VALUES =================

    const balance = Number(wallet.balance || 0);
    const lifetimeEarned = Number(
      wallet.lifetimeEarned || 0
    );
    const pending = Number(wallet.pending || 0);

    let displayBalance = balance;
    let displayLifetimeEarned = lifetimeEarned;
    let displayPending = pending;
    let exchangeRate = 1;
    let exchangeData = null;

    // ================= CURRENCY CONVERSION =================

    if (currency !== BASE_CURRENCY) {
      exchangeData = await getExchangeRates();

      const ngnRate = Number(
        exchangeData.rates[BASE_CURRENCY]
      );

      const targetRate = Number(
        exchangeData.rates[currency]
      );

      if (
        !Number.isFinite(ngnRate) ||
        ngnRate <= 0 ||
        !Number.isFinite(targetRate) ||
        targetRate <= 0
      ) {
        throw new Error(
          `Exchange rate unavailable for ${currency}`
        );
      }

      // ExchangeRate-API uses USD as its base.
      // Convert NGN -> USD -> selected currency.

      exchangeRate = targetRate / ngnRate;

      displayBalance = balance * exchangeRate;
      displayLifetimeEarned =
        lifetimeEarned * exchangeRate;
      displayPending = pending * exchangeRate;
    }

    return json({
      // ================= AUTHORITATIVE NGN VALUES =================

      balance,
      lifetimeEarned,
      pending,

      // ================= SELECTED DISPLAY CURRENCY =================

      currency,
      displayBalance,
      displayLifetimeEarned,
      displayPending,
      exchangeRate,
      baseCurrency: BASE_CURRENCY,

      // ================= POINTS / COUNTERS =================

      points: wallet.points || 0,
      storyLikes: wallet.storyLikes || 0,
      storyViews: wallet.storyViews || 0,
      reelLikes: wallet.reelLikes || 0,
      reelViews: wallet.reelViews || 0,
      videoLikes: wallet.videoLikes || 0,
      videoViews: wallet.videoViews || 0,
      referralPoints: wallet.referralPoints || 0,
      leaderboardPoints: wallet.leaderboardPoints || 0,

      // ================= RATE INFORMATION =================

      exchangeRateSource:
        currency === BASE_CURRENCY
          ? null
          : "ExchangeRate-API Open Access",

      exchangeRateUpdatedAt:
        exchangeData?.lastUpdateUnix
          ? new Date(
              exchangeData.lastUpdateUnix * 1000
            )
          : null,

      exchangeRateNextUpdateAt:
        exchangeData?.nextUpdateUnix
          ? new Date(
              exchangeData.nextUpdateUnix * 1000
            )
          : null,
    });

  } catch (error) {
    console.error("GET WALLET ERROR:", error);

    if (
      error.message === "Authentication required" ||
      error.message === "Invalid token" ||
      error.message === "Token expired" ||
      error.message === "Invalid user ID"
    ) {
      return json({
        error: error.message,
      }, 401);
    }

    return json({
      error: error.message,
    }, 500);
  }
}

/* ================= CONVERT POINTS ================= */

export async function convertPoints(request, env, db) {
  try {
    if (!env.JWT_SECRET) {
      return json({
        success: false,
        error: "JWT_SECRET is not configured",
      }, 500);
    }

    const token = getToken(request);

    if (!token) {
      return json({
        success: false,
        error: "Authentication required",
      }, 401);
    }

    const payload = await verifyJWT(
      token,
      env.JWT_SECRET
    );

    if (!payload.id) {
      return json({
        success: false,
        error: "Invalid authentication token",
      }, 401);
    }

    if (!ObjectId.isValid(payload.id)) {
      return json({
        success: false,
        error: "Invalid user ID",
      }, 401);
    }

    const userId = new ObjectId(payload.id);

    // ================= CHECK USER ROLE =================

    const user = await db.collection("users").findOne(
      { _id: userId },
      { projection: { role: 1, deletionStatus: 1 } }
    );

    const deletionStatus = String(
      user?.deletionStatus || ""
    ).toLowerCase();

    if (["requested", "pending", "processing", "review_required"].includes(deletionStatus)) {
      return json({
        success: false,
        code: "ACCOUNT_DELETION_PENDING",
        error: "Points conversion is disabled while account deletion is pending.",
      }, 403);
    }

    const isAdmin = user?.role === "admin";

    let wallet = await db.collection("wallets").findOne({
      user: userId,
    });

    if (!wallet) {
      wallet = {
        user: userId,
        balance: 0,
        points: 0,
        storyLikes: 0,
        storyViews: 0,
        reelLikes: 0,
        reelViews: 0,
        videoLikes: 0,
        videoViews: 0,
        referralPoints: 0,
        leaderboardPoints: 0,
        lifetimeEarned: 0,
        pending: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await db.collection("wallets").insertOne(wallet);
    }

    // ================= SELECTED CURRENCY =================

    let body = {};

    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const currency = String(
      body.currency || BASE_CURRENCY
    ).toUpperCase();

    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return json({
        success: false,
        error: `Unsupported currency: ${currency}`,
      }, 400);
    }

    const points = Number(wallet.points || 0);

    // Admins may convert below 10,000 points for testing.
    // Normal users must have at least 10,000 points.
    if (points <= 0) {
      return json({
        success: false,
        error: "No points available for conversion",
      }, 400);
    }

    if (points < MIN_CONVERSION_POINTS && !isAdmin) {
      return json({
        success: false,
        error: `Minimum ${MIN_CONVERSION_POINTS.toLocaleString()} points required`,
      }, 400);
    }

    // ================= BASE NGN VALUE =================

    const baseAmount = points * RATE;

    // ================= EXCHANGE RATE =================

    let exchangeData = null;
    let convertedAmount = baseAmount;

    // NGN is the authoritative base currency.
    // No external exchange-rate request is needed for NGN.
    if (currency !== BASE_CURRENCY) {
      exchangeData = await getExchangeRates();

      const ngnRate = Number(
        exchangeData.rates[BASE_CURRENCY]
      );

      const targetRate = Number(
        exchangeData.rates[currency]
      );

      if (
        !Number.isFinite(ngnRate) ||
        ngnRate <= 0 ||
        !Number.isFinite(targetRate) ||
        targetRate <= 0
      ) {
        throw new Error(
          `Exchange rate unavailable for ${currency}`
        );
      }

      // ExchangeRate-API uses USD as its base.
      // Convert NGN -> USD -> selected currency.
      convertedAmount =
        (baseAmount / ngnRate) * targetRate;
    }

    // Rate of selected currency relative to the NGN base value.
    const effectiveExchangeRate =
      convertedAmount / baseAmount;

    // Wallet balance remains the authoritative NGN value.
    const newBalance =
      (wallet.balance || 0) + baseAmount;

    const newLifetimeEarned =
      (wallet.lifetimeEarned || 0) + baseAmount;

    await db.collection("wallets").updateOne(
      {
        _id: wallet._id,
      },
      {
        $set: {
          balance: newBalance,
          lifetimeEarned: newLifetimeEarned,
          points: 0,
          updatedAt: new Date(),
        },
      }
    );

    await db.collection("transactions").insertOne({
      user: userId,
      type: "conversion",
      category: "points_conversion",
      points: -points,
      amount: convertedAmount,
      currency,
      paymentMethod: "wallet",
      reference: `POINTS-${Date.now()}`,
      gatewayReference: "",
      status: "success",
      description: "Converted points to wallet balance",
      metadata: {
        pointsConverted: points,
        baseCurrency: BASE_CURRENCY,
        baseAmount,
        convertedAmount,
        effectiveExchangeRate,
        exchangeRateSource: "ExchangeRate-API Open Access",
        exchangeRateBase: exchangeData?.baseCurrency || BASE_CURRENCY,
        exchangeRateUpdatedAt: exchangeData?.lastUpdateUnix
          ? new Date(
              exchangeData.lastUpdateUnix * 1000
            )
          : null,
        exchangeRateNextUpdateAt: exchangeData?.nextUpdateUnix
          ? new Date(
              exchangeData.nextUpdateUnix * 1000
            )
          : null,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return json({
      success: true,
      message: "Points converted successfully",
      balance: newBalance,
      earned: baseAmount,
      baseCurrency: BASE_CURRENCY,
      baseAmount,
      currency,
      convertedAmount,
      exchangeRate: effectiveExchangeRate,
      pointsConverted: points,
    });

  } catch (error) {
    console.error(
      "POINT CONVERSION ERROR:",
      error
    );

    return json({
      success: false,
      error: "Conversion failed",
    }, 500);
  }
}

/* ================= TRANSACTION HISTORY ================= */

export async function getTransactions(request, env, db) {
  try {
    if (!env.JWT_SECRET) {
      return json({
        success: false,
        error: "JWT_SECRET is not configured",
      }, 500);
    }

    const token = getToken(request);

    if (!token) {
      return json({
        success: false,
        error: "Authentication required",
      }, 401);
    }

    const payload = await verifyJWT(
      token,
      env.JWT_SECRET
    );

    if (!payload.id || !ObjectId.isValid(payload.id)) {
      return json({
        success: false,
        error: "Invalid authentication token",
      }, 401);
    }

    const userId = new ObjectId(payload.id);

    const url = new URL(request.url);

    const page = Math.max(
      Number(url.searchParams.get("page") || 1),
      1
    );

    const limit = Math.min(
      Math.max(
        Number(url.searchParams.get("limit") || 20),
        1
      ),
      100
    );

    const skip = (page - 1) * limit;

    const filter = {
      user: userId,
    };

    const [transactions, total] = await Promise.all([
      db.collection("transactions")
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),

      db.collection("transactions")
        .countDocuments(filter),
    ]);

    return json({
      success: true,
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });

  } catch (error) {
    console.error(
      "GET TRANSACTIONS ERROR:",
      error
    );

    return json({
      success: false,
      error: error.message,
    }, 500);
  }
}

/* ================= ADMIN POINTS ADJUSTMENT ================= */

export async function adminAdjustPoints(request, env, db) {
  try {
    if (!env.JWT_SECRET) {
      return json({
        success: false,
        error: "JWT_SECRET is not configured",
      }, 500);
    }

    const token = getToken(request);

    if (!token) {
      return json({
        success: false,
        error: "Authentication required",
      }, 401);
    }

    const payload = await verifyJWT(
      token,
      env.JWT_SECRET
    );

    if (!payload.id || !ObjectId.isValid(payload.id)) {
      return json({
        success: false,
        error: "Invalid authentication token",
      }, 401);
    }

    const adminUserId = new ObjectId(payload.id);

    /* ================= VERIFY ADMIN ================= */

    const adminUser = await db.collection("users").findOne(
      { _id: adminUserId },
      { projection: { role: 1 } }
    );

    if (adminUser?.role !== "admin") {
      return json({
        success: false,
        error: "Admin access required",
      }, 403);
    }

    /* ================= READ REQUEST ================= */

    let body;

    try {
      body = await request.json();
    } catch {
      return json({
        success: false,
        error: "Invalid JSON request body",
      }, 400);
    }

    const { userId, action, points, reason } = body;

    if (!userId || !ObjectId.isValid(userId)) {
      return json({
        success: false,
        error: "Valid target userId is required",
      }, 400);
    }

    if (action !== "add" && action !== "deduct") {
      return json({
        success: false,
        error: "Action must be either add or deduct",
      }, 400);
    }

    const amount = Number(points);

    if (
      !Number.isInteger(amount) ||
      amount <= 0
    ) {
      return json({
        success: false,
        error: "Points must be a positive whole number",
      }, 400);
    }

    if (
      !reason ||
      typeof reason !== "string" ||
      !reason.trim()
    ) {
      return json({
        success: false,
        error: "Reason is required",
      }, 400);
    }

    const targetUserId = new ObjectId(userId);

    /* ================= VERIFY TARGET USER ================= */

    const targetUser = await db.collection("users").findOne(
      { _id: targetUserId },
      { projection: { _id: 1, deletionStatus: 1 } }
    );

    if (!targetUser) {
      return json({
        success: false,
        error: "Target user not found",
      }, 404);
    }

    if (
      ["requested", "pending", "processing", "review_required"].includes(
        String(targetUser.deletionStatus || "").toLowerCase()
      )
    ) {
      return json({
        success: false,
        code: "ACCOUNT_DELETION_PENDING",
        error: "Administrative point adjustments are disabled while account deletion is pending.",
      }, 409);
    }

    /* ================= CALCULATE CHANGE ================= */

    const pointsChange =
      action === "add"
        ? amount
        : -amount;

    /* ================= UPDATE WALLET ================= */

    let updateResult;

    if (action === "deduct") {
      updateResult = await db.collection("wallets").findOneAndUpdate(
        {
          user: targetUserId,
          points: { $gte: amount },
        },
        {
          $inc: {
            points: -amount,
          },
          $set: {
            updatedAt: new Date(),
          },
          $setOnInsert: {
            user: targetUserId,
            balance: 0,
            lifetimeEarned: 0,
            pending: 0,
            createdAt: new Date(),
          },
        },
        {
          returnDocument: "after",
        }
      );
    } else {
      updateResult = await db.collection("wallets").findOneAndUpdate(
        { user: targetUserId },
        {
          $inc: {
            points: amount,
          },
          $set: {
            updatedAt: new Date(),
          },
          $setOnInsert: {
            user: targetUserId,
            balance: 0,
            lifetimeEarned: 0,
            pending: 0,
            createdAt: new Date(),
          },
        },
        {
          upsert: true,
          returnDocument: "after",
        }
      );
    }

    const updatedWallet =
      updateResult?.value || updateResult;

    if (!updatedWallet) {
      return json({
        success: false,
        error: "Insufficient points for deduction",
      }, 400);
    }

    const newPoints = Number(
      updatedWallet.points || 0
    );

    /* ================= RECORD TRANSACTION ================= */

    await db.collection("transactions").insertOne({
      user: targetUserId,
      type: "points",
      category: "admin_adjustment",
      points: pointsChange,
      amount: 0,
      currency: "NGN",
      paymentMethod: "admin",
      reference: `ADMIN-POINTS-${Date.now()}`,
      status: "success",
      description: reason.trim(),
      metadata: {
        action,
        reason: reason.trim(),
        adminUser: adminUserId.toString(),
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    /* ================= NOTIFY USER ================= */

    await db.collection("notifications").insertOne({
      recipient: targetUserId,
      type: "POINT_ADJUSTMENT",
      text:
        action === "add"
          ? `AfricSocial added ${amount} points to your wallet`
          : `AfricSocial deducted ${amount} points from your wallet`,
      count: 1,
      read: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return json({
      success: true,
      message:
        action === "add"
          ? "Points added successfully"
          : "Points deducted successfully",
      userId: targetUserId.toString(),
      pointsChanged: pointsChange,
      points: newPoints,
    });

  } catch (error) {
    console.error(
      "ADMIN POINTS ADJUSTMENT ERROR:",
      error
    );

    return json({
      success: false,
      error: error.message,
    }, 500);
  }
}


/* ================= ADMIN WALLET ADJUSTMENT HISTORY ================= */

export async function adminAdjustmentHistory(request, env, db) {
  try {
    if (!env.JWT_SECRET) {
      return json({
        success: false,
        error: "JWT_SECRET is not configured",
      }, 500);
    }

    const token = getToken(request);

    if (!token) {
      return json({
        success: false,
        error: "Authentication required",
      }, 401);
    }

    const payload = await verifyJWT(
      token,
      env.JWT_SECRET
    );

    if (!payload.id || !ObjectId.isValid(payload.id)) {
      return json({
        success: false,
        error: "Invalid authentication token",
      }, 401);
    }

    const adminUserId = new ObjectId(payload.id);

    /* ================= VERIFY ADMIN ================= */

    const adminUser = await db.collection("users").findOne(
      { _id: adminUserId },
      { projection: { role: 1 } }
    );

    if (adminUser?.role !== "admin") {
      return json({
        success: false,
        error: "Admin access required",
      }, 403);
    }

    /* ================= PAGINATION ================= */

    const url = new URL(request.url);

    const page = Math.max(
      Number(url.searchParams.get("page") || 1),
      1
    );

    const limit = Math.min(
      Math.max(
        Number(url.searchParams.get("limit") || 20),
        1
      ),
      100
    );

    const skip = (page - 1) * limit;

    /* ================= GET TOTAL ================= */

    const historyFilter =
      url.searchParams.get("filter") || "all";

    const filter = {
      category: "admin_adjustment",
    };

    if (
      historyFilter === "add"
    ) {
      filter["metadata.action"] = "add";
    }

    if (
      historyFilter === "deduct"
    ) {
      filter["metadata.action"] = "deduct";
    }

    const total =
      await db.collection("transactions")
        .countDocuments(filter);

    /* ================= GET TRANSACTIONS ================= */

    const transactions =
      await db.collection("transactions")
        .find(filter)
        .sort({
          createdAt: -1,
          _id: -1,
        })
        .skip(skip)
        .limit(limit)
        .toArray();

    /* ================= GET USERS ================= */

    const userIds = transactions
      .map(transaction => transaction.user)
      .filter(userId => userId && ObjectId.isValid(userId));

    const uniqueUserIds = [
      ...new Map(
        userIds.map(userId => [
          userId.toString(),
          userId,
        ])
      ).values(),
    ];

    const users =
      uniqueUserIds.length
        ? await db.collection("users")
            .find({
              _id: {
                $in: uniqueUserIds,
              },
            })
            .project({
              _id: 1,
              name: 1,
              email: 1,
              phone: 1,
              profilePic: 1,
            })
            .toArray()
        : [];

    const userMap =
      new Map(
        users.map(user => [
          user._id.toString(),
          user,
        ])
      );

    /* ================= GET ADMIN USERS ================= */

    const adminIds = transactions
      .map(transaction =>
        transaction.metadata?.adminUser
      )
      .filter(adminId =>
        adminId &&
        ObjectId.isValid(adminId)
      );

    const uniqueAdminIds = [
      ...new Set(
        adminIds.map(adminId =>
          adminId.toString()
        )
      ),
    ];

    const adminObjectIds =
      uniqueAdminIds.map(
        adminId => new ObjectId(adminId)
      );

    const admins =
      adminObjectIds.length
        ? await db.collection("users")
            .find({
              _id: {
                $in: adminObjectIds,
              },
            })
            .project({
              _id: 1,
              name: 1,
              email: 1,
            })
            .toArray()
        : [];

    const adminMap =
      new Map(
        admins.map(admin => [
          admin._id.toString(),
          admin,
        ])
      );

    /* ================= FORMAT RESULTS ================= */

    const results =
      transactions.map(transaction => {
        const targetUser =
          transaction.user
            ? userMap.get(
                transaction.user.toString()
              )
            : null;

        const adminId =
          transaction.metadata?.adminUser
            ? transaction.metadata.adminUser.toString()
            : "";

        const admin =
          adminId
            ? adminMap.get(adminId)
            : null;

        return {
          _id: transaction._id.toString(),

          user: targetUser
            ? {
                _id: targetUser._id.toString(),
                name: targetUser.name || "",
                email: targetUser.email || "",
                phone: targetUser.phone || "",
                profilePic: targetUser.profilePic || "",
              }
            : {
                _id: transaction.user
                  ? transaction.user.toString()
                  : "",
                name: "",
                email: "",
                phone: "",
                profilePic: "",
              },

          action:
            transaction.metadata?.action || (
              Number(transaction.points || 0) >= 0
                ? "add"
                : "deduct"
            ),

          points: Number(
            transaction.points || 0
          ),

          reason:
            transaction.description ||
            transaction.metadata?.reason ||
            "",

          admin: admin
            ? {
                _id: admin._id.toString(),
                name: admin.name || "",
                email: admin.email || "",
              }
            : {
                _id: adminId,
                name: "",
                email: "",
              },

          createdAt:
            transaction.createdAt ||
            transaction.updatedAt ||
            null,
        };
      });

    return json({
      success: true,
      adjustments: results,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(
          total / limit
        ),
      },
    });

  } catch (error) {
    console.error(
      "ADMIN ADJUSTMENT HISTORY ERROR:",
      error
    );

    return json({
      success: false,
      error: error.message,
    }, 500);
  }
}

/* ================= ADMIN WALLET USER SEARCH ================= */

export async function adminSearchUsers(request, env, db) {
  try {
    if (!env.JWT_SECRET) {
      return json({
        success: false,
        error: "JWT_SECRET is not configured",
      }, 500);
    }

    const token = getToken(request);

    if (!token) {
      return json({
        success: false,
        error: "Authentication required",
      }, 401);
    }

    const payload = await verifyJWT(
      token,
      env.JWT_SECRET
    );

    if (!payload.id || !ObjectId.isValid(payload.id)) {
      return json({
        success: false,
        error: "Invalid authentication token",
      }, 401);
    }

    const adminUserId = new ObjectId(payload.id);

    /* ================= VERIFY ADMIN ================= */

    const adminUser = await db.collection("users").findOne(
      { _id: adminUserId },
      { projection: { role: 1 } }
    );

    if (adminUser?.role !== "admin") {
      return json({
        success: false,
        error: "Admin access required",
      }, 403);
    }

    /* ================= READ QUERY ================= */

    const url = new URL(request.url);

    const search =
      (url.searchParams.get("search") || "").trim();

    const hasSearch = search.length >= 2;

    /* ================= PAGINATION ================= */

    const page = Math.max(
      Number(url.searchParams.get("page") || 1),
      1
    );

    const limit = Math.min(
      Math.max(
        Number(url.searchParams.get("limit") || 20),
        1
      ),
      100
    );

    const skip = (page - 1) * limit;

    /* ================= BUILD FILTER ================= */

    let filter = {};

    if (hasSearch) {
      const regex =
        new RegExp(
          search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          "i"
        );

      filter = {
        $or: [
          { name: regex },
          { email: regex },
          { phone: regex },
        ],
      };
    }

    /* ================= COUNT USERS ================= */

    const total =
      await db.collection("users")
        .countDocuments(filter);

    /* ================= FIND USERS ================= */

    const users = await db.collection("users")
      .find(filter)
      .project({
        _id: 1,
        name: 1,
        email: 1,
        phone: 1,
        profilePic: 1,
        intro: 1,
      })
      .sort({
        name: 1,
        _id: 1,
      })
      .skip(hasSearch ? 0 : skip)
      .limit(hasSearch ? 10 : limit)
      .toArray();

    /* ================= GET WALLET POINTS ================= */

    const userIds =
      users.map(user => user._id);

    const wallets =
      userIds.length
        ? await db.collection("wallets")
            .find({
              user: {
                $in: userIds,
              },
            })
            .project({
              user: 1,
              points: 1,
            })
            .toArray()
        : [];

    const walletMap =
      new Map(
        wallets.map(wallet => [
          wallet.user.toString(),
          Number(wallet.points || 0),
        ])
      );

    /* ================= FORMAT RESULTS ================= */

    const results =
      users.map(user => ({
        _id: user._id.toString(),
        name: user.name || "",
        email: user.email || "",
        phone: user.phone || "",
        profilePic: user.profilePic || "",
        intro: user.intro || "",
        points:
          walletMap.get(
            user._id.toString()
          ) || 0,
      }));

    return json({
      success: true,
      users: results,
      ...(hasSearch
        ? {}
        : {
            pagination: {
              page,
              limit,
              total,
              totalPages: Math.ceil(total / limit),
            },
          }),
    });

  } catch (error) {
    console.error(
      "ADMIN SEARCH USERS ERROR:",
      error
    );

    return json({
      success: false,
      error: error.message,
    }, 500);
  }
}
