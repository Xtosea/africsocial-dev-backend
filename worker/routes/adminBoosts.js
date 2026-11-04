import { ObjectId } from "mongodb";

import {
  approveBoost,
  rejectBoost,
} from "../utils/boosts.js";

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
  const authorization =
    request.headers.get("Authorization");

  if (!authorization) {
    return null;
  }

  const parts =
    authorization.trim().split(/\s+/);

  if (
    parts.length !== 2 ||
    parts[0] !== "Bearer"
  ) {
    return null;
  }

  return parts[1];
}

function base64UrlDecode(value) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded =
    base64 +
    "=".repeat(
      (4 - (base64.length % 4)) % 4
    );

  return atob(padded);
}

async function verifyJWT(token, secret) {
  const unauthorized = (message) => {
    const error = new Error(message);
    error.status = 401;
    return error;
  };

  if (!token) {
    throw unauthorized("Authentication required");
  }

  const parts = token.split(".");

  if (parts.length !== 3) {
    throw unauthorized("Invalid token");
  }

  const [
    encodedHeader,
    encodedPayload,
    encodedSignature,
  ] = parts;

  try {
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
      throw unauthorized("Invalid token");
    }

    const payload = JSON.parse(
      base64UrlDecode(encodedPayload)
    );

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
  throw unauthorized("Invalid token");
}

if (
  Object.prototype.hasOwnProperty.call(payload, "exp") &&
  (
    typeof payload.exp !== "number" ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= Math.floor(Date.now() / 1000)
  )
) {
  throw unauthorized("Token expired or invalid");
}

    return payload;
  } catch (error) {
    if (error.status === 401) {
      throw error;
    }

    throw unauthorized("Invalid token");
  }
}

export async function authenticateAdmin(
  request,
  env,
  db
) {
  if (!env.JWT_SECRET) {
    throw new Error(
      "JWT_SECRET is not configured"
    );
  }

  const token =
    getToken(request);

  if (!token) {
    const error =
      new Error(
        "Authentication required"
      );

    error.status = 401;
    throw error;
  }

  const payload =
    await verifyJWT(
      token,
      env.JWT_SECRET
    );

  if (
    !payload.id ||
    !ObjectId.isValid(payload.id)
  ) {
    const error =
      new Error(
        "Invalid authentication token"
      );

    error.status = 401;
    throw error;
  }

  const adminUserId =
    new ObjectId(payload.id);

  const adminUser =
    await db.collection("users").findOne(
      {
        _id: adminUserId,
      },
      {
        projection: {
          role: 1,
          name: 1,
          email: 1,
        },
      }
    );

  if (
    adminUser?.role !== "admin"
  ) {
    const error =
      new Error(
        "Admin access required"
      );

    error.status = 403;
    throw error;
  }

  return {
    adminUserId,
    adminUser,
  };
}

/* ================= ADMIN BOOST LIST ================= */

export async function getPendingBoosts(
  request,
  env,
  db
) {
  try {
    const {
      adminUserId,
    } = await authenticateAdmin(
      request,
      env,
      db
    );

    const url =
      new URL(request.url);

    const page = Math.max(
      Number(
        url.searchParams.get(
          "page"
        ) || 1
      ),
      1
    );

    const limit = Math.min(
      Math.max(
        Number(
          url.searchParams.get(
            "limit"
          ) || 20
        ),
        1
      ),
      100
    );

    const skip =
      (page - 1) * limit;

    const filter = {
      status: "pending_approval",
    };

    const [
      boosts,
      total,
    ] = await Promise.all([
      db.collection("boosts")
        .find(filter)
        .sort({
          createdAt: -1,
          _id: -1,
        })
        .skip(skip)
        .limit(limit)
        .toArray(),

      db.collection("boosts")
        .countDocuments(filter),
    ]);

    const userIds = [
      ...new Map(
        boosts
          .map(boost => boost.user)
          .filter(Boolean)
          .map(userId => [
            userId.toString(),
            userId,
          ])
      ).values(),
    ];

    const postIds = [
      ...new Map(
        boosts
          .map(boost => boost.post)
          .filter(Boolean)
          .map(postId => [
            postId.toString(),
            postId,
          ])
      ).values(),
    ];

    const listingIds = [
      ...new Map(
        boosts
          .map(boost => boost.listing)
          .filter(Boolean)
          .map(listingId => [
            listingId.toString(),
            listingId,
          ])
      ).values(),
    ];

    const [
      users,
      posts,
      listings,
    ] = await Promise.all([
      userIds.length
        ? db.collection("users")
            .find({
              _id: {
                $in: userIds,
              },
            })
            .project({
              _id: 1,
              name: 1,
              email: 1,
              profilePic: 1,
            })
            .toArray()
        : [],

      postIds.length
        ? db.collection("posts")
            .find({
              _id: {
                $in: postIds,
              },
            })
            .project({
              _id: 1,
              user: 1,
              content: 1,
              text: 1,
              media: 1,
              isReel: 1,
              isSharedPost: 1,
              createdAt: 1,
            })
            .toArray()
        : [],

      listingIds.length
        ? db.collection("marketplaces")
            .find({
              _id: {
                $in: listingIds,
              },
            })
            .project({
              _id: 1,
              seller: 1,
              title: 1,
              description: 1,
              price: 1,
              currency: 1,
              images: 1,
              status: 1,
              location: 1,
              createdAt: 1,
            })
            .toArray()
        : [],
    ]);

    const userMap =
      new Map(
        users.map(user => [
          user._id.toString(),
          user,
        ])
      );

    const postMap =
      new Map(
        posts.map(post => [
          post._id.toString(),
          post,
        ])
      );

    const listingMap =
      new Map(
        listings.map(listing => [
          listing._id.toString(),
          listing,
        ])
      );

    const results =
      boosts.map(boost => {
        const user =
          boost.user
            ? userMap.get(
                boost.user.toString()
              )
            : null;

        const post =
          boost.post
            ? postMap.get(
                boost.post.toString()
              )
            : null;

        const listing =
          boost.listing
            ? listingMap.get(
                boost.listing.toString()
              )
            : null;

        return {
          id: boost._id.toString(),
          productId: boost.productId,
          amount: boost.amount,
          currency: boost.currency,
          status: boost.status,

          user: user
            ? {
                id: user._id.toString(),
                name: user.name || "",
                email: user.email || "",
                profilePic:
                  user.profilePic || "",
              }
            : null,

          post: post
            ? {
                id: post._id.toString(),
                content:
                  post.content ||
                  post.text ||
                  "",
                media:
                  Array.isArray(
                    post.media
                  )
                    ? post.media
                    : [],
                isReel:
                  post.isReel === true,
                isSharedPost:
                  post.isSharedPost === true,
                createdAt:
                  post.createdAt || null,
              }
            : null,

          listing: listing
            ? {
                id: listing._id.toString(),
                title: listing.title || "",
                description:
                  listing.description || "",
                price:
                  listing.price ?? 0,
                currency:
                  listing.currency || "NGN",
                images:
                  Array.isArray(
                    listing.images
                  )
                    ? listing.images
                    : [],
                status:
                  listing.status || "",
                location:
                  listing.location || null,
                createdAt:
                  listing.createdAt || null,
              }
            : null,

          transactionReference:
            boost.transactionReference,

          gatewayReference:
            boost.gatewayReference ||
            null,

          createdAt:
            boost.createdAt ||
            null,
        };
      });

    return json({
      success: true,
      boosts: results,
      pagination: {
        page,
        limit,
        total,
        totalPages:
          Math.ceil(
            total / limit
          ),
      },
      adminUserId:
        adminUserId.toString(),
    });
  } catch (error) {
    console.error(
      "GET PENDING BOOSTS ERROR:",
      error
    );

    return json(
      {
        success: false,
        error:
          error.message ||
          "Failed to load pending Boosts.",
      },
      error.status || 500
    );
  }
}

/* ================= APPROVE BOOST ================= */

export async function approveBoostAdmin(
  request,
  env,
  db,
  boostId
) {
  try {
    const {
      adminUserId,
    } = await authenticateAdmin(
      request,
      env,
      db
    );

    if (
      !ObjectId.isValid(boostId)
    ) {
      return json(
        {
          success: false,
          error: "Invalid Boost ID.",
        },
        400
      );
    }

    const boost =
      await approveBoost(
        db,
        boostId,
        adminUserId
      );

    return json({
      success: true,
      message:
        "Boost approved successfully.",
      boost,
    });
  } catch (error) {
    console.error(
      "APPROVE BOOST ERROR:",
      error
    );

    return json(
      {
        success: false,
        error:
          error.message ||
          "Failed to approve Boost.",
      },
      error.status || 500
    );
  }
}

/* ================= REJECT BOOST ================= */

export async function rejectBoostAdmin(
  request,
  env,
  db,
  boostId
) {
  try {
    const {
      adminUserId,
    } = await authenticateAdmin(
      request,
      env,
      db
    );

    if (
      !ObjectId.isValid(boostId)
    ) {
      return json(
        {
          success: false,
          error: "Invalid Boost ID.",
        },
        400
      );
    }

    let body = {};

    try {
      body =
        await request.json();
    } catch {
      body = {};
    }

    const reason =
      String(
        body.reason || ""
      ).trim();

    if (!reason) {
      return json(
        {
          success: false,
          error:
            "Rejection reason is required.",
        },
        400
      );
    }

    const boost =
      await rejectBoost(
        db,
        boostId,
        adminUserId,
        reason
      );

    return json({
      success: true,
      message:
        "Boost rejected successfully.",
      boost,
    });
  } catch (error) {
    console.error(
      "REJECT BOOST ERROR:",
      error
    );

    return json(
      {
        success: false,
        error:
          error.message ||
          "Failed to reject Boost.",
      },
      error.status || 500
    );
  }
}
