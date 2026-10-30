import { ObjectId } from "mongodb";
import { getProduct } from "./products.js";

/**
 * Activate an advertisement only after its Paystack payment is verified.
 * The campaign reservation and stored payment must agree.
 */
export async function activateVerifiedAdvertisement(db, payment) {
  if (!payment || payment.status !== "paid") {
    throw new Error("Payment has not been verified as paid.");
  }
  if (!payment.transactionReference) {
    throw new Error("Payment transaction reference is missing.");
  }

  const product = getProduct(payment.productId);
  if (!product || product.type !== "advertisement") {
    throw new Error("Invalid advertisement payment product.");
  }

  if (!payment.user || !payment.advertisementCampaignId) {
    throw new Error("Advertisement payment is missing its owner or campaign.");
  }

  const rawId = payment.advertisementCampaignId;
  const campaignId =
    rawId instanceof ObjectId
      ? rawId
      : ObjectId.isValid(String(rawId))
        ? new ObjectId(String(rawId))
        : null;

  if (!campaignId) {
    throw new Error("Advertisement campaign ID is invalid.");
  }

  const campaign = await db.collection("advertisement_campaigns").findOne({
    _id: campaignId,
    advertiserId: payment.user,
  });

  if (!campaign) {
    throw new Error("Advertisement campaign not found for this advertiser.");
  }

  if (
    campaign.productId !== payment.productId ||
    (campaign.productType && campaign.productType !== "advertisement") ||
    campaign.paymentReference !== payment.transactionReference ||
    Number(campaign.amount) !== Number(payment.amount) ||
    String(campaign.currency || "NGN") !== String(payment.currency || "NGN")
  ) {
    throw new Error("Advertisement campaign and payment details do not match.");
  }

  // Idempotency: only this exact campaign may count as already activated.
  if (
    campaign.paymentStatus === "paid" &&
    campaign.status === "active"
  ) {
    return {
      activated: false,
      alreadyActivated: true,
      campaign: serializeAdvertisementCampaign(campaign),
    };
  }

  // Do not revive cancelled campaigns or accept an unreserved payment.
  if (
    campaign.status !== "pending_payment" ||
    campaign.paymentStatus !== "unpaid"
  ) {
    throw new Error("Advertisement campaign is not awaiting this payment.");
  }

  const durationDays = Number(campaign.durationDays);
  if (!Number.isInteger(durationDays) || durationDays <= 0) {
    throw new Error("Advertisement campaign duration is invalid.");
  }

  const now = new Date();
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() + durationDays);

  const result = await db.collection("advertisement_campaigns").updateOne(
    {
      _id: campaign._id,
      advertiserId: payment.user,
      productId: payment.productId,
      status: "pending_payment",
      paymentStatus: "unpaid",
      paymentReference: payment.transactionReference,
      amount: campaign.amount,
    },
    {
      $set: {
        paymentStatus: "paid",
        paymentGatewayReference: payment.gatewayReference || null,
        paymentProvider: payment.provider || "paystack",
        paidAmount: payment.amount,
        currency: payment.currency || "NGN",
        status: "active",
        startDate: now,
        endDate,
        updatedAt: now,
        activatedAt: now,
      },
    },
  );

  const updated = await db.collection("advertisement_campaigns").findOne({
    _id: campaign._id,
    advertiserId: payment.user,
  });

  if (
    result.modifiedCount === 1 &&
    updated &&
    updated.paymentStatus === "paid" &&
    updated.status === "active" &&
    updated.paymentReference === payment.transactionReference
  ) {
    return {
      activated: true,
      alreadyActivated: false,
      campaign: serializeAdvertisementCampaign(updated),
    };
  }

  // A concurrent verification may have completed the same activation.
  if (
    updated &&
    updated.paymentStatus === "paid" &&
    updated.status === "active" &&
    updated.paymentReference === payment.transactionReference &&
    Number(updated.paidAmount) === Number(payment.amount)
  ) {
    return {
      activated: false,
      alreadyActivated: true,
      campaign: serializeAdvertisementCampaign(updated),
    };
  }

  throw new Error("Advertisement campaign activation could not be confirmed.");
}

function serializeAdvertisementCampaign(campaign) {
  if (!campaign) return null;

  return {
    ...campaign,
    _id: campaign._id?.toString?.() || campaign._id,
    advertiserId:
      campaign.advertiserId?.toString?.() || campaign.advertiserId,
    createdBy: campaign.createdBy?.toString?.() || campaign.createdBy,
    paymentReference: campaign.paymentReference || null,
    paymentGatewayReference: campaign.paymentGatewayReference || null,
  };
}
