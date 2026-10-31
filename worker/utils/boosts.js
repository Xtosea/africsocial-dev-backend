import { ObjectId } from "mongodb";

import {
  getProduct,
} from "./products.js";

function toObjectId(value) {
  if (!value) return null;

  if (value instanceof ObjectId) {
    return value;
  }

  try {
    return new ObjectId(String(value));
  } catch {
    return null;
  }
}

function calculateBoostExpiry(
  product,
  startedAt
) {
  if (
    product.neverExpires ||
    product.durationDays == null
  ) {
    return null;
  }

  const expiresAt =
    new Date(startedAt);

  expiresAt.setDate(
    expiresAt.getDate() +
      Number(product.durationDays)
  );

  return expiresAt;
}

function cleanBoost(boost) {
  return {
    id: boost._id?.toString() || null,
    user: boost.user?.toString() || null,
    post: boost.post?.toString() || null,
    listing: boost.listing?.toString() || null,
      boostConfig: boost.boostConfig || null,
    productId: boost.productId,
    amount: boost.amount,
    currency: boost.currency,
    status: boost.status,
    startedAt: boost.startedAt,
    expiresAt: boost.expiresAt,
    paymentProvider:
      boost.paymentProvider,
    transactionReference:
      boost.transactionReference,
    gatewayReference:
      boost.gatewayReference || null,
    approvedBy:
      boost.approvedBy?.toString() || null,
    approvedAt:
      boost.approvedAt || null,
    rejectedBy:
      boost.rejectedBy?.toString() || null,
    rejectedAt:
      boost.rejectedAt || null,
    rejectionReason:
      boost.rejectionReason || null,
    createdAt: boost.createdAt,
    updatedAt: boost.updatedAt,
  };
}

export async function activateVerifiedBoost(
  db,
  payment
) {
  if (!payment) {
    throw new Error("Payment record is required.");
  }

  if (payment.status !== "paid") {
    throw new Error("Payment has not been verified as paid.");
  }

  if (!payment.transactionReference) {
    throw new Error("Payment transaction reference is missing.");
  }

  const product = getProduct(payment.productId);

  if (!product) {
    throw new Error("Payment product no longer exists.");
  }

  if (product.type !== "boost") {
    throw new Error(
      "This payment product does not use Boost activation."
    );
  }

  const userId = toObjectId(payment.user);

  if (!userId) {
    throw new Error("Payment contains an invalid user ID.");
  }

  const postId = toObjectId(payment.targetPostId);
  const listingId = toObjectId(payment.targetListingId);

  if (!postId && !listingId) {
    throw new Error(
      "A Boost target post, Reel, or Marketplace listing is required."
    );
  }

  if (postId && listingId) {
    throw new Error(
      "A Boost payment cannot target both a post and a Marketplace listing."
    );
  }

  let targetPost = null;
  let targetListing = null;

  if (postId) {
    targetPost = await db.collection("posts").findOne({
      _id: postId,
    });

    if (!targetPost) {
      throw new Error(
        "The post or Reel to boost was not found."
      );
    }

    if (String(targetPost.user) !== String(userId)) {
      throw new Error(
        "You can only boost your own content."
      );
    }

    // Shared posts cannot be boosted.
    if (targetPost.isSharedPost === true) {
      throw new Error(
        "Shared posts cannot be boosted."
      );
    }

    // A Boost must contain media.
    if (
      !Array.isArray(targetPost.media) ||
      targetPost.media.length === 0
    ) {
      throw new Error(
        "Only posts with photos or videos can be boosted."
      );
    }
  }

  if (listingId) {
    targetListing = await db.collection("marketplaces").findOne({
      _id: listingId,
    });

    if (!targetListing) {
      throw new Error(
        "The Marketplace listing to boost was not found."
      );
    }

    if (
      String(targetListing.seller) !==
      String(userId)
    ) {
      throw new Error(
        "You can only boost your own Marketplace listing."
      );
    }
  }

  const existingActivation =
    await db.collection("boosts").findOne({
      transactionReference:
        payment.transactionReference,
    });

  if (existingActivation) {
    return {
      activated:
        existingActivation.status === "active",
      alreadyActivated: true,
      boost: cleanBoost(existingActivation),
    };
  }

  const createdAt = new Date();

  // Payment is verified, but the Boost must
  // wait for admin approval before becoming active.
  const boost = {
    user: userId,
    post: postId || null,
    listing: listingId || null,
    productId: product.id,
    boostConfig: payment.boostConfig || null,
    amount: payment.amount,
    currency: payment.currency,
    status: "pending_approval",

    // These begin only after admin approval.
    startedAt: null,
    expiresAt: null,

    paymentProvider:
      payment.provider || "paystack",
    transactionReference:
      payment.transactionReference,
    gatewayReference:
      payment.gatewayReference || null,

    approvedBy: null,
    approvedAt: null,

    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,

    createdAt,
    updatedAt: createdAt,
  };

  try {
    const result =
      await db.collection("boosts").insertOne(boost);

    boost._id = result.insertedId;

    await db.collection("payments").updateOne(
      {
        _id: payment._id,
      },
      {
        $set: {
          activationStatus: "pending_approval",
          activatedAt: null,
          updatedAt: new Date(),
        },
      }
    );

    return {
      activated: false,
      alreadyActivated: false,
      boost: cleanBoost(boost),
    };
  } catch (error) {
    if (error?.code === 11000) {
      const duplicate =
        await db.collection("boosts").findOne({
          transactionReference:
            payment.transactionReference,
        });

      if (duplicate) {
        return {
          activated:
            duplicate.status === "active",
          alreadyActivated: true,
          boost: cleanBoost(duplicate),
        };
      }
    }

    throw error;
  }
}

export async function approveBoost(
  db,
  boostId,
  adminUserId
) {
  const objectBoostId = toObjectId(boostId);
  const adminId = toObjectId(adminUserId);

  if (!objectBoostId) {
    throw new Error("Invalid Boost ID.");
  }

  if (!adminId) {
    throw new Error("Invalid admin user ID.");
  }

  const boost = await db.collection("boosts").findOne({
    _id: objectBoostId,
  });

  if (!boost) {
    throw new Error("Boost not found.");
  }

  if (boost.status !== "pending_approval") {
    throw new Error(
      "Only pending Boosts can be approved."
    );
  }

  // A Boost must have a valid owner and payment reference.
  const boostUserId = toObjectId(boost.user);

  if (!boostUserId || !boost.transactionReference) {
    throw new Error(
      "Boost ownership or payment reference could not be verified."
    );
  }

  // Verify the original payment independently of the Boost record.
  const payment = await db.collection("payments").findOne({
    transactionReference: boost.transactionReference,
  });

  if (!payment) {
    throw new Error(
      "Boost payment record was not found. Approval is blocked."
    );
  }

  if (
    payment.status !== "paid" ||
    String(toObjectId(payment.user)) !== String(boostUserId) ||
    payment.productId !== boost.productId
  ) {
    throw new Error(
      "Boost payment verification failed. Approval is blocked."
    );
  }

  // Do not approve payments awaiting financial or activation review.
  if (
    payment.accountDeletionReviewRequired === true ||
    payment.accountDeletionReviewStatus === "pending" ||
    payment.activationReviewRequired === true ||
    payment.activationReviewStatus === "pending"
  ) {
    throw new Error(
      "This Boost payment requires financial review. Approval is blocked."
    );
  }

  // Verify the account still exists and is not undergoing deletion.
  const owner = await db.collection("users").findOne(
    { _id: boostUserId },
    { projection: { deletionStatus: 1 } }
  );

  if (!owner) {
    throw new Error(
      "Boost account owner could not be found. Approval is blocked."
    );
  }

  const deletionStatus = String(
    owner.deletionStatus || ""
  ).toLowerCase();

  if (
    ["requested", "pending", "processing", "review_required"].includes(
      deletionStatus
    )
  ) {
    throw new Error(
      "This account has an active deletion process. Boost approval is blocked."
    );
  }

  // Check the deletion-request collection independently because the
  // user record and deletion request may temporarily be out of sync.
  const deletionRequest = await db
    .collection("account_deletion_requests")
    .findOne({
      userId: boostUserId,
    });

  if (
    deletionRequest &&
    String(deletionRequest.status || "").toLowerCase() !== "cancelled"
  ) {
    throw new Error(
      "This account has an unresolved deletion request. Boost approval is blocked."
    );
  }

  const product = getProduct(boost.productId);

  if (!product || product.type !== "boost") {
    throw new Error(
      "Boost product no longer exists or is invalid."
    );
  }

  const startedAt = new Date();

  const expiresAt = calculateBoostExpiry(
    product,
    startedAt
  );

  const result = await db.collection("boosts").findOneAndUpdate(
    {
      _id: objectBoostId,
      status: "pending_approval",
    },
    {
      $set: {
        status: "active",
        startedAt,
        expiresAt,
        approvedBy: adminId,
        approvedAt: startedAt,
        updatedAt: startedAt,
      },
    },
    {
      returnDocument: "after",
    }
  );

  if (!result) {
    throw new Error(
      "Boost could not be approved."
    );
  }

  return cleanBoost(result);
}

export async function rejectBoost(
  db,
  boostId,
  adminUserId,
  rejectionReason
) {
  const objectBoostId =
    toObjectId(boostId);

  const adminId =
    toObjectId(adminUserId);

  if (!objectBoostId) {
    throw new Error(
      "Invalid Boost ID."
    );
  }

  if (!adminId) {
    throw new Error(
      "Invalid admin user ID."
    );
  }

  const reason =
    String(
      rejectionReason || ""
    ).trim();

  if (!reason) {
    throw new Error(
      "A rejection reason is required."
    );
  }

  const now =
    new Date();

  const result =
    await db.collection("boosts").findOneAndUpdate(
      {
        _id: objectBoostId,
        status: "pending_approval",
      },
      {
        $set: {
          status: "rejected",
          rejectedBy: adminId,
          rejectedAt: now,
          rejectionReason: reason,
          updatedAt: now,
        },
      },
      {
        returnDocument: "after",
      }
    );

  if (!result) {
    throw new Error(
      "Boost not found or is no longer pending approval."
    );
  }

  return cleanBoost(result);
}
