import { getProduct } from "./products.js";

/**
 * Activate a verified Advertisement payment.
 *
 * IMPORTANT:
 * - Payment must already be verified as paid by Paystack.
 * - The stored payment record is the source of truth.
 * - Activation is idempotent using transactionReference.
 */
export async function activateVerifiedAdvertisement(db, payment) {
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

  if (product.type !== "advertisement") {
    throw new Error(
      "This payment product does not use Advertisement activation."
    );
  }

  const userId = payment.user;

  if (!userId) {
    throw new Error("Payment contains an invalid user ID.");
  }

  const campaigns = db.collection("advertisement_campaigns");

  // Idempotency: this payment may already have been processed.
  const existingCampaign = await campaigns.findOne({
    paymentReference: payment.transactionReference,
    advertiserId: userId,
  });

  if (existingCampaign) {
    return {
      activated: existingCampaign.status === "active",
      alreadyActivated: true,
      campaign: serializeAdvertisementCampaign(existingCampaign),
    };
  }

  const campaignId = payment.advertisementCampaignId;

  if (!campaignId) {
    throw new Error(
      "Advertisement campaign reference is missing from payment."
    );
  }

  const campaign = await campaigns.findOne({
    _id: campaignId,
    advertiserId: userId,
  });

  if (!campaign) {
    throw new Error("Advertisement campaign not found.");
  }

  if (
    campaign.status !== "pending_payment" ||
    campaign.paymentStatus !== "unpaid"
  ) {
    throw new Error(
      "Advertisement campaign is not awaiting payment."
    );
  }

  const now = new Date();

  const updateResult = await campaigns.updateOne(
    {
      _id: campaign._id,
      advertiserId: userId,
      status: "pending_payment",
      paymentStatus: "unpaid",
    },
    {
      $set: {
        paymentStatus: "paid",
        paymentReference: payment.transactionReference,
        paymentGatewayReference: payment.gatewayReference || null,
        paymentProvider: payment.provider || "paystack",
        paidAmount: payment.amount,
        currency: payment.currency || "NGN",
        status: "pending_approval",
        startDate: null,
        endDate: null,
        updatedAt: now,
      },
    }
  );

  // Re-read after updating to handle concurrent verification requests.
  const updatedCampaign = await campaigns.findOne({
    _id: campaign._id,
    advertiserId: userId,
  });

  if (!updatedCampaign) {
    throw new Error("Advertisement campaign could not be retrieved.");
  }

  if (
    updatedCampaign.paymentReference !== payment.transactionReference ||
    updatedCampaign.paymentStatus !== "paid"
  ) {
    throw new Error(
      "Advertisement campaign payment could not be confirmed."
    );
  }

  return {
    activated: updatedCampaign.status === "active",
    alreadyActivated: updateResult.modifiedCount === 0,
    campaign: serializeAdvertisementCampaign(updatedCampaign),
  };
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
    paymentGatewayReference:
      campaign.paymentGatewayReference || null,
  };
}