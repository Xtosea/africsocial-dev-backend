import { ObjectId } from "mongodb";

import {
  getProduct,
  getProductPrice,
} from "../utils/products.js";

import {
  initializePaystackTransaction,
  verifyPaystackTransaction,
} from "../utils/paystack.js";

import {
  authenticate,
} from "../utils/auth.js";

import {
  getActivePremiumSubscription,
} from "../utils/premium.js";

import {
  activateVerifiedPayment,
} from "../utils/paymentActivation.js";

import {
  activateVerifiedAdvertisement,
} from "../utils/advertisementActivation.js";

import {
  activateVerifiedBoost,
} from "../utils/boosts.js";

import {
  buildSubscriptionRecord,
} from "../utils/subscriptions.js";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods":
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization",
    },
  });
}

/**
 * Generate an AfricSocial payment reference.
 *
 * Only letters, numbers, "-", ".", "=" are used,
 * matching Paystack's reference requirements.
 */
function generatePaymentReference() {
  const random = crypto.randomUUID()
    .replace(/-/g, "")
    .slice(0, 20);

  return `AFS-${Date.now()}-${random}`;
}

/**
 * Convert a major currency amount to the smallest
 * currency unit used by Paystack.
 *
 * NGN:
 *   5,000 NGN -> 500,000 kobo
 */
function toPaystackSubunit(amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Invalid payment amount.");
  }

  return Math.round(amount * 100);
}

/**
 * POST /api/payments/paystack/initialize
 *
 * The client supplies:
 *   {
 *     productId: "premium_monthly"
 *   }
 *
 * The backend determines:
 *   - product
 *   - product type
 *   - authoritative price
 *   - currency
 */
export async function initializePaystackPayment(
  request,
  env,
  db
) {
  try {
    const userId = await authenticate(
      request,
      env
    );

    const user = await db.collection("users").findOne({
      _id: userId,
    });

    if (!user) {
      return json({
        success: false,
        message: "User account not found.",
      }, 404);
    }

    const deletionStatus = String(
      user.deletionStatus || ""
    ).toLowerCase();

    if (["requested", "pending", "processing", "review_required"].includes(deletionStatus)) {
      return json({
        success: false,
        code: "ACCOUNT_DELETION_PENDING",
        message: "New purchases are disabled while account deletion is pending.",
      }, 403);
    }

    if (!user.email) {
      return json({
        success: false,
        code: "EMAIL_REQUIRED",
        message:
          "A valid email address is required for Paystack payment. Please add an email address to your AfricSocial account.",
      }, 400);
    }

    const body = await request.json();

    const productId =
      typeof body?.productId === "string"
        ? body.productId.trim()
        : "";

    if (!productId) {
      return json({
        success: false,
        message: "Product ID is required.",
      }, 400);
    }

    const product = getProduct(productId);

    if (!product) {
      return json({
        success: false,
        message: "Invalid product.",
      }, 400);
    }

    const currency = "NGN";

    let amount = getProductPrice(productId, currency);

    if (!Number.isFinite(amount) || amount <= 0) {
      return json({
        success: false,
        message:
          "This product is not available for NGN payment.",
      }, 400);
    }

    let targetPostId = null;
    let boostConfig = null;
    let advertisementCampaignId = null;
    let advertisementCampaign = null;

    if (product.type === "boost") {
      const rawTargetPostId =
        typeof body?.targetPostId === "string"
          ? body.targetPostId.trim()
          : "";

      if (!rawTargetPostId) {
        return json({
          success: false,
          code: "TARGET_POST_REQUIRED",
          message:
            "A target post or Reel is required for a Boost payment.",
        }, 400);
      }

      if (!ObjectId.isValid(rawTargetPostId)) {
        return json({
          success: false,
          code: "INVALID_TARGET_POST",
          message:
            "The target post or Reel ID is invalid.",
        }, 400);
      }

      targetPostId =
        new ObjectId(rawTargetPostId);

      const targetPost =
        await db.collection("posts").findOne({
          _id: targetPostId,
        });

      if (!targetPost) {
        return json({
          success: false,
          code: "TARGET_POST_NOT_FOUND",
          message:
            "The post or Reel to boost was not found.",
        }, 404);
      }

      if (
        String(targetPost.user) !==
        String(userId)
      ) {
        return json({
          success: false,
          code: "TARGET_POST_NOT_OWNED",
          message:
            "You can only boost your own content.",
        }, 403);
      }
       const rawBoostConfig =
       body?.boostConfig;
      if (
        !rawBoostConfig ||
        typeof rawBoostConfig !== "object" ||
        Array.isArray(rawBoostConfig)
      ) {
        return json({
          success: false,
          code: "BOOST_CONFIG_REQUIRED",
          message:
            "Boost configuration is required.",
        }, 400);
      }

      const allowedGoals = [
        "views",
        "engagement",
        "profile_visits",
        "followers",
      ];

      const allowedAudiences = [
        "automatic",
        "custom",
      ];

      const allowedGenders = [
        "all",
        "male",
        "female",
      ];

      const normalizedGoal =
        typeof rawBoostConfig.goal === "string"
          ? rawBoostConfig.goal.trim()
          : "";

      const normalizedAudience =
        typeof rawBoostConfig.audience === "string"
          ? rawBoostConfig.audience.trim()
          : "";

      const normalizedDuration =
        Number(rawBoostConfig.durationDays);

      const normalizedStartMode =
        typeof rawBoostConfig.startMode === "string"
          ? rawBoostConfig.startMode.trim()
          : "";

      if (!allowedGoals.includes(normalizedGoal)) {
        return json({
          success: false,
          code: "INVALID_BOOST_GOAL",
          message: "Invalid Boost goal.",
        }, 400);
      }

      if (
        !allowedAudiences.includes(
          normalizedAudience
        )
      ) {
        return json({
          success: false,
          code: "INVALID_BOOST_AUDIENCE",
          message: "Invalid Boost audience.",
        }, 400);
      }

      if (
        !Number.isInteger(normalizedDuration) ||
        normalizedDuration < 1 ||
        normalizedDuration > 30
      ) {
        return json({
          success: false,
          code: "INVALID_BOOST_DURATION",
          message:
            "Boost duration must be between 1 and 30 days.",
        }, 400);
      }

      if (
        normalizedStartMode !== "now" &&
        normalizedStartMode !== "scheduled"
      ) {
        return json({
          success: false,
          code: "INVALID_BOOST_START_MODE",
          message: "Invalid Boost start mode.",
        }, 400);
      }

      let normalizedTargeting = null;

      if (normalizedAudience === "custom") {
        const rawTargeting =
          rawBoostConfig.targeting;

        if (
          !rawTargeting ||
          typeof rawTargeting !== "object" ||
          Array.isArray(rawTargeting)
        ) {
          return json({
            success: false,
            code: "INVALID_BOOST_TARGETING",
            message:
              "Custom audience targeting is required.",
          }, 400);
        }

        const targetingGender =
          typeof rawTargeting.gender === "string"
            ? rawTargeting.gender.trim()
            : "all";

        if (
          !allowedGenders.includes(
            targetingGender
          )
        ) {
          return json({
            success: false,
            code: "INVALID_BOOST_GENDER",
            message:
              "Invalid Boost gender targeting.",
          }, 400);
        }

        const targetingAgeMin =
          Number(rawTargeting.ageMin);

        const targetingAgeMax =
          Number(rawTargeting.ageMax);

        if (
          !Number.isInteger(targetingAgeMin) ||
          !Number.isInteger(targetingAgeMax) ||
          targetingAgeMin < 13 ||
          targetingAgeMax > 100 ||
          targetingAgeMin > targetingAgeMax
        ) {
          return json({
            success: false,
            code: "INVALID_BOOST_AGE_RANGE",
            message:
              "Boost age range is invalid.",
          }, 400);
        }

        normalizedTargeting = {
          niche:
            typeof rawTargeting.niche === "string"
              ? rawTargeting.niche.trim()
              : "",

          country:
            typeof rawTargeting.country === "string"
              ? rawTargeting.country.trim()
              : "",

          state:
            typeof rawTargeting.state === "string"
              ? rawTargeting.state.trim()
              : "",

          city:
            typeof rawTargeting.city === "string"
              ? rawTargeting.city.trim()
              : "",

          ageMin: targetingAgeMin,
          ageMax: targetingAgeMax,
          gender: targetingGender,
        };
      }

      let normalizedScheduledStart = null;

      if (normalizedStartMode === "scheduled") {
        if (
          typeof rawBoostConfig.scheduledStart !==
          "string" ||
          !rawBoostConfig.scheduledStart.trim()
        ) {
          return json({
            success: false,
            code: "BOOST_SCHEDULE_REQUIRED",
            message:
              "A scheduled Boost start time is required.",
          }, 400);
        }

        const parsedScheduledStart =
          new Date(
            rawBoostConfig.scheduledStart
          );

        if (
          Number.isNaN(
            parsedScheduledStart.getTime()
          )
        ) {
          return json({
            success: false,
            code: "INVALID_BOOST_SCHEDULE",
            message:
              "The scheduled Boost start time is invalid.",
          }, 400);
        }

        if (
          parsedScheduledStart.getTime() <=
          Date.now()
        ) {
          return json({
            success: false,
            code: "BOOST_SCHEDULE_IN_PAST",
            message:
              "The scheduled Boost start time must be in the future.",
          }, 400);
        }

        normalizedScheduledStart =
          parsedScheduledStart;
      }

      boostConfig = {
        goal: normalizedGoal,
        audience: normalizedAudience,
        targeting: normalizedTargeting,
        durationDays: normalizedDuration,
        startMode: normalizedStartMode,
        scheduledStart: normalizedScheduledStart,
      };
    }

        else if (product.type === "advertisement") {

          const rawCampaignId =

            typeof body?.advertisementCampaignId === "string"

              ? body.advertisementCampaignId.trim()

              : "";



          if (!rawCampaignId || !ObjectId.isValid(rawCampaignId)) {

            return json({

              success: false,

              code: "INVALID_ADVERTISEMENT_CAMPAIGN",

              message: "A valid advertisement campaign ID is required.",

            }, 400);

          }



          advertisementCampaignId = new ObjectId(rawCampaignId);



          advertisementCampaign =

            await db.collection("advertisement_campaigns").findOne({

              _id: advertisementCampaignId,

              advertiserId: new ObjectId(userId),

            });



          if (!advertisementCampaign) {

            return json({

              success: false,

              code: "ADVERTISEMENT_CAMPAIGN_NOT_FOUND",

              message: "The advertisement campaign was not found for this account.",

            }, 404);

          }



          if (

            advertisementCampaign.productId !== product.id ||

            (advertisementCampaign.productType &&

              advertisementCampaign.productType !== "advertisement")

          ) {

            return json({

              success: false,

              code: "ADVERTISEMENT_PRODUCT_MISMATCH",

              message: "The campaign does not match the selected advertisement product.",

            }, 400);

          }



          if (

            advertisementCampaign.status !== "pending_payment" ||

            advertisementCampaign.paymentStatus !== "unpaid" ||

            (advertisementCampaign.paymentReference != null &&

              advertisementCampaign.paymentReference !== "")

          ) {

            return json({

              success: false,

              code: "ADVERTISEMENT_CAMPAIGN_NOT_PAYABLE",

              message: "This campaign is no longer available for checkout.",

            }, 409);

          }



          const savedAmount = Number(advertisementCampaign.amount);

          const catalogueAmount = getProductPrice(product.id, "NGN");



          if (

            !Number.isFinite(savedAmount) ||

            savedAmount <= 0 ||

            advertisementCampaign.currency !== "NGN"

          ) {

            return json({

              success: false,

              code: "INVALID_ADVERTISEMENT_AMOUNT",

              message: "The saved campaign amount or currency is invalid.",

            }, 400);

          }



          if (product.customAmountAllowed === true) {

            if (

              !Number.isFinite(Number(product.minimumAmount)) ||

              savedAmount < Number(product.minimumAmount)

            ) {

              return json({

                success: false,

                code: "ADVERTISEMENT_AMOUNT_TOO_LOW",

                message: "The campaign amount is below the product minimum.",

              }, 400);

            }

          } else if (

            !Number.isFinite(catalogueAmount) ||

            savedAmount !== catalogueAmount

          ) {

            return json({

              success: false,

              code: "ADVERTISEMENT_AMOUNT_MISMATCH",

              message: "The campaign amount does not match the selected product.",

            }, 400);

          }



          amount = savedAmount;

        }



    else if (product.type !== "premium") {
      return json({
        success: false,
        code: "PRODUCT_NOT_READY",
        message:
          "Payment for this product is not activated yet.",
      }, 400);
    }

    /*
     * Prevent a user with an existing active subscription
     * from accidentally buying the same plan while we are
     * building the payment flow.
     *
     * Later, users will be allowed to intentionally stack
     * Premium plans.
     */
    const existingSubscription =
      product.type === "premium"
        ? await getActivePremiumSubscription(db, userId)
        : null;

    const transactionReference =
      generatePaymentReference();

    const paystackAmount =
      toPaystackSubunit(amount);

    const createdAt = new Date();

    const paymentRecord = {
      user: new ObjectId(userId),

      provider: "paystack",

      transactionReference,

      gatewayReference: null,

      productId: product.id,

      productType: product.type,

      targetPostId,
      advertisementCampaignId,

      amount,

      paystackAmount,

      currency,

      status: "pending",

      paymentMethod: null,

      channel: null,

      gatewayStatus: null,

      gatewayResponse: null,

      paidAt: null,

      verifiedAt: null,

      activatedAt: null,

      createdAt,

      updatedAt: createdAt,
    };

    await db.collection("payments").insertOne(
      paymentRecord
    );

    if (advertisementCampaign) {
      const reserveResult =
        await db.collection("advertisement_campaigns").updateOne(
          {
            _id: advertisementCampaign._id,
            advertiserId: new ObjectId(userId),
            status: "pending_payment",
            paymentStatus: "unpaid",
            $or: [
              { paymentReference: null },
              { paymentReference: { $exists: false } },
              { paymentReference: "" },
            ],
          },
          {
            $set: {
              paymentReference: transactionReference,
              paymentCheckoutStatus: "initializing",
              paymentCheckoutStartedAt: createdAt,
              updatedAt: createdAt,
            },
          }
        );

      if (reserveResult.modifiedCount !== 1) {
        await db.collection("payments").updateOne(
          { transactionReference, status: "pending" },
          {
            $set: {
              status: "failed",
              gatewayStatus: "campaign_reservation_conflict",
              updatedAt: new Date(),
            },
          }
        );

        return json({
          success: false,
          code: "ADVERTISEMENT_RESERVATION_CONFLICT",
          message: "The campaign could not be reserved for checkout. Please refresh and try again.",
        }, 409);
      }
    }

    try {
      const paystackResponse =
        await initializePaystackTransaction(
          env,
          {
            email: user.email,
            amount: paystackAmount,
            currency,
            reference: transactionReference,

            /*
             * Allow the Paystack checkout to present
             * supported payment methods configured for
             * the merchant, including bank transfer.
             */
            channels: [
              "card",
              "bank",
              "ussd",
              "qr",
              "mobile_money",
              "bank_transfer",
            ],

            metadata: JSON.stringify({
              userId: userId.toString(),
              productId: product.id,
              productType: product.type,
              currency,
              amount,
              transactionReference,
              ...(targetPostId
                ? {
                    targetPostId:
                      targetPostId.toString(),
                  }
                : {}),
              ...(advertisementCampaignId
                ? {
                    advertisementCampaignId:
                      advertisementCampaignId.toString(),
                  }
                : {}),
            }),
          }
        );

      const gatewayData =
        paystackResponse?.data || {};

      try {
      await db.collection("payments").updateOne(
        {
          transactionReference,
        },
        {
          $set: {
            gatewayReference:
              gatewayData.reference ||
              transactionReference,

            gatewayStatus:
              "initialized",

            gatewayResponse: {
              authorization_url:
                gatewayData.authorization_url ||
                null,

              access_code:
                gatewayData.access_code ||
                null,

              reference:
                gatewayData.reference ||
                null,
            },

            updatedAt: new Date(),
          },
        }
      );
      } catch (persistenceError) {
        console.error("PAYSTACK INITIALIZATION PERSISTENCE ERROR:", persistenceError);
      }

      return json({
        success: true,

        payment: {
          transactionReference,

          productId: product.id,

          productName: product.name,

          productType: product.type,

          amount,

          currency,

          authorizationUrl:
            gatewayData.authorization_url ||
            null,

          accessCode:
            gatewayData.access_code ||
            null,

          reference:
            gatewayData.reference ||
            transactionReference,

          hasExistingPremium:
            Boolean(existingSubscription),
        },
      });
    } catch (paystackError) {
      const paystackStatus = Number(paystackError?.paystackStatus);

      // Release a campaign only when Paystack clearly rejected the request.
      // Timeouts, rate limits, invalid responses and server errors remain uncertain.
      const isDefiniteRejection =
        [400, 401, 403, 404, 422].includes(paystackStatus);

// Preserve the reference when Paystack's outcome is uncertain.
if (!isDefiniteRejection) {
  paystackError.transactionReference = transactionReference;
  paystackError.paymentOutcomeUnknown = true;
} else {
  paystackError.paymentInitializationRejected = true;
}

      const failedAt = new Date();

      await db.collection("payments").updateOne(
        { transactionReference },
        {
          $set: {
            status: isDefiniteRejection ? "failed" : "pending",
            gatewayStatus: isDefiniteRejection
              ? "initialize_rejected"
              : "initialize_outcome_unknown",
            gatewayResponse:
              paystackError?.paystackResponse || {
                message:
                  paystackError?.message ||
                  "Paystack initialization failed.",
              },
            updatedAt: failedAt,
          },
        }
      );

      if (advertisementCampaign && isDefiniteRejection) {
        // Release only this transaction's reservation. Never clear a newer one.
        await db.collection("advertisement_campaigns").updateOne(
          {
            _id: advertisementCampaign._id,
            advertiserId: new ObjectId(userId),
            status: "pending_payment",
            paymentStatus: "unpaid",
            paymentReference: transactionReference,
          },
          {
            $set: {
              paymentReference: null,
              paymentCheckoutStatus: "rejected",
              paymentCheckoutFailedAt: failedAt,
              updatedAt: failedAt,
            },
          }
        );
      }

      throw paystackError;
    }
  } catch (error) {
    console.error(
      "PAYSTACK INITIALIZE ERROR:",
      error
    );

    const message =
      error?.message ===
        "Authentication required" ||
      error?.message === "Invalid token" ||
      error?.message === "Token expired" ||
      error?.message ===
        "Invalid authentication token" ||
      error?.message === "Invalid user ID"
        ? error.message
        : error?.message ===
          "PAYSTACK_SECRET_KEY is not configured"
        ? error.message
        : "Failed to initialize payment.";

    const status =
      message ===
        "PAYSTACK_SECRET_KEY is not configured"
        ? 500
        : error?.message ===
            "Authentication required" ||
          error?.message === "Invalid token" ||
          error?.message === "Token expired" ||
          error?.message ===
            "Invalid authentication token" ||
          error?.message === "Invalid user ID"
        ? 401
        : 500;

    return json({
      success: false,
      message,
      ...(error?.paymentOutcomeUnknown && error?.transactionReference
        ? {
            transactionReference: error.transactionReference,
            paymentOutcomeUnknown: true,
          }
        : {}),
      ...(error?.paymentInitializationRejected
        ? { paymentInitializationRejected: true }
        : {}),
    }, status);
  }
}

/**
 * GET /api/payments/paystack/verify/:reference
 *
 * This endpoint verifies the payment directly with
 * Paystack. It does NOT trust a frontend success message.
 *
 * Premium activation will be connected after the
 * webhook/idempotency layer is added.
 */

export async function recoverPaystackCheckout(
  request,
  env,
  db,
  reference
) {
  try {
    const userId = await authenticate(request, env);
    const transactionReference = String(reference || "").trim();

    if (!transactionReference) {
      return json({
        success: false,
        code: "PAYMENT_REFERENCE_REQUIRED",
        message: "Payment reference is required.",
      }, 400);
    }

    const payment = await db.collection("payments").findOne({
      transactionReference,
    });

    if (!payment) {
      return json({
        success: false,
        code: "PAYMENT_NOT_FOUND",
        message: "Payment record not found.",
      }, 404);
    }

    if (String(payment.user) !== String(userId)) {
      return json({
        success: false,
        code: "PAYMENT_ACCESS_DENIED",
        message: "You are not authorized to access this payment.",
      }, 403);
    }

    const currentUser = await db.collection("users").findOne(
      { _id: userId },
      { projection: { deletionStatus: 1 } }
    );

    const deletionStatus = String(
      currentUser?.deletionStatus || ""
    ).toLowerCase();

    if (["requested", "pending", "processing", "review_required"].includes(deletionStatus)) {
      return json({
        success: false,
        code: "ACCOUNT_DELETION_PENDING",
        message: "Checkout recovery is disabled while account deletion is pending.",
      }, 403);
    }

    if (String(payment.status || "").toLowerCase() === "paid") {
      return json({
        success: false,
        code: "PAYMENT_ALREADY_COMPLETED",
        message: "This payment is already marked as paid. Check its payment status instead of reopening checkout.",
      }, 409);
    }

    // Check Paystack directly before returning an existing checkout URL.
    // Fail closed if Paystack cannot confirm the transaction's current state.
    let liveGatewayData;

    try {
      const liveResponse = await verifyPaystackTransaction(
        env,
        transactionReference
      );
      liveGatewayData = liveResponse?.data || {};
    } catch (verificationError) {
      console.error(
        "PAYSTACK CHECKOUT RECOVERY STATUS CHECK ERROR:",
        verificationError
      );

      return json({
        success: false,
        code: "PAYMENT_STATUS_UNAVAILABLE",
        message: "We could not confirm the current payment status. Please check the payment status again shortly.",
      }, 503);
    }

    if (
      String(liveGatewayData.reference || "") !== transactionReference
    ) {
      return json({
        success: false,
        code: "PAYMENT_REFERENCE_MISMATCH",
        message: "Paystack could not confirm the expected payment reference. Do not start another payment.",
      }, 409);
    }

    if (String(liveGatewayData.status || "").toLowerCase() === "success") {
      return json({
        success: false,
        code: "PAYMENT_REQUIRES_VERIFICATION",
        message: "Paystack reports a successful transaction. Check the existing payment status to complete verification.",
        verifyUrl: `/api/payments/paystack/verify/${encodeURIComponent(transactionReference)}`,
      }, 409);
    }

    if (!["ongoing", "pending"].includes(
      String(liveGatewayData.status || "").toLowerCase()
    )) {
      return json({
        success: false,
        code: "CHECKOUT_NOT_RECOVERABLE",
        message: "Paystack does not report this transaction as an ongoing checkout. Check its status before attempting another payment.",
        paymentStatus: liveGatewayData.status || "unknown",
      }, 409);
    }

    const authorizationUrl =
      payment.gatewayResponse?.authorization_url;

    if (
      String(payment.status || "").toLowerCase() !== "pending" ||
      String(payment.gatewayStatus || "").toLowerCase() !== "initialized" ||
      typeof authorizationUrl !== "string" ||
      !/^https:\/\/checkout\.paystack\.com\//i.test(authorizationUrl)
    ) {
      return json({
        success: false,
        code: "CHECKOUT_NOT_RECOVERABLE",
        message: "Saved checkout details are unavailable or no longer eligible for recovery. Check the existing payment status before attempting another payment.",
      }, 409);
    }

    return json({
      success: true,
      recovered: true,
      payment: {
        reference: transactionReference,
        authorizationUrl,
        accessCode: payment.gatewayResponse?.access_code || null,
      },
    });
  } catch (error) {
    console.error("PAYSTACK CHECKOUT RECOVERY ERROR:", error);

    const message =
      error?.message === "Authentication required" ||
      error?.message === "Invalid token" ||
      error?.message === "Token expired" ||
      error?.message === "Invalid authentication token" ||
      error?.message === "Invalid user ID"
        ? error.message
        : "Failed to recover the existing checkout.";

    return json({
      success: false,
      message,
    }, message === "Failed to recover the existing checkout." ? 500 : 401);
  }
}

export async function verifyPaystackPayment(
  request,
  env,
  db,
  reference
) {
  try {
    const userId = await authenticate(
      request,
      env
    );

    const transactionReference =
      String(reference || "").trim();

    if (!transactionReference) {
      return json({
        success: false,
        message:
          "Payment reference is required.",
      }, 400);
    }

    const payment =
      await db.collection("payments").findOne({
        transactionReference,
      });

    if (!payment) {
      return json({
        success: false,
        message: "Payment record not found.",
      }, 404);
    }

    if (
      String(payment.user) !==
      String(userId)
    ) {
      return json({
        success: false,
        message:
          "You are not authorized to access this payment.",
      }, 403);
    }

    const paystackResponse =
      await verifyPaystackTransaction(
        env,
        transactionReference
      );

    const gatewayData =
      paystackResponse?.data || {};

    const expectedAmount =
      Number(payment.paystackAmount);

    const receivedAmount =
      Number(gatewayData.amount);

    const receivedCurrency =
      String(
        gatewayData.currency || ""
      ).toUpperCase();

    const referenceMatches =
      String(
        gatewayData.reference || ""
      ) === transactionReference;

    const amountMatches =
      Number.isFinite(receivedAmount) &&
      receivedAmount === expectedAmount;

    const currencyMatches =
      receivedCurrency ===
      String(payment.currency).toUpperCase();

    const paymentSuccessful =
      gatewayData.status === "success";

    if (
      !paymentSuccessful ||
      !referenceMatches ||
      !amountMatches ||
      !currencyMatches
    ) {
      await db.collection("payments").updateOne(
        {
          transactionReference,
        },
        {
          $set: {
            gatewayStatus:
              gatewayData.status ||
              "verification_failed",

            gatewayReference:
              gatewayData.id != null
                ? String(gatewayData.id)
                : payment.gatewayReference,

            gatewayResponse: gatewayData,

            updatedAt: new Date(),
          },
        }
      );

      return json({
        success: false,
        status:
          gatewayData.status ||
          "verification_failed",
        message:
          "Payment has not been verified successfully.",
      }, 400);
    }

    await db.collection("payments").updateOne(
      {
        transactionReference,
      },
      {
        $set: {
          status: "paid",

          gatewayStatus:
            gatewayData.status,

          gatewayReference:
            gatewayData.id != null
              ? String(gatewayData.id)
              : payment.gatewayReference,

          paymentMethod:
            gatewayData.channel ||
            null,

          channel:
            gatewayData.channel ||
            null,

          gatewayResponse: gatewayData,

          paidAt:
            gatewayData.paid_at
              ? new Date(
                  gatewayData.paid_at
                )
              : new Date(),

          verifiedAt: new Date(),

          updatedAt: new Date(),
        },
      }
    );

    const verifiedPayment = {
      ...payment,
      status: "paid",
      gatewayReference:
        gatewayData.id != null
          ? String(gatewayData.id)
          : payment.gatewayReference,
    };

    const currentUser = await db.collection("users").findOne(
      { _id: userId },
      { projection: { deletionStatus: 1 } }
    );

    const currentDeletionStatus = String(
      currentUser?.deletionStatus || ""
    ).toLowerCase();

    if (
      ["requested", "pending", "processing", "review_required"].includes(
        currentDeletionStatus
      )
    ) {
      await db.collection("payments").updateOne(
        { transactionReference },
        {
          $set: {
            accountDeletionReviewRequired: true,
            accountDeletionReviewStatus: "pending",
            accountDeletionReviewReason: "account_deletion_pending",
            updatedAt: new Date(),
          },
        }
      );

      return json({
        success: true,
        verified: true,
        activated: false,
        requiresReview: true,
        message:
          "Payment verified successfully, but account deletion is pending. " +
          "The payment has been flagged for review; no new product was activated.",
        payment: {
          transactionReference,
          productId: payment.productId,
          productType: payment.productType,
          amount: payment.amount,
          currency: payment.currency,
          channel: gatewayData.channel || null,
          status: "paid",
          reviewStatus: "pending",
        },
      });
    }

    let activation;

    try {
      activation =
        payment.productType === "advertisement"
          ? await activateVerifiedAdvertisement(db, verifiedPayment)
          : payment.productType === "boost"
            ? await activateVerifiedBoost(db, verifiedPayment)
            : await activateVerifiedPayment(db, verifiedPayment);
    } catch (activationError) {
      if (payment.productType !== "advertisement") {
        throw activationError;
      }

      console.error(
        "ADVERTISEMENT ACTIVATION ERROR:",
        activationError
      );

      await db.collection("payments").updateOne(
        { transactionReference, status: "paid" },
        {
          $set: {
            activationReviewRequired: true,
            activationReviewStatus: "pending",
            activationReviewReason: "advertisement_activation_failed",
            updatedAt: new Date(),
          },
        }
      );

      return json({
        success: true,
        verified: true,
        activated: false,
        requiresReview: true,
        message:
          "Payment was verified successfully, but advertisement activation could not be completed. The payment has been flagged for review.",
        payment: {
          transactionReference,
          productId: payment.productId,
          productType: payment.productType,
          amount: payment.amount,
          currency: payment.currency,
          channel: gatewayData.channel || null,
          status: "paid",
          reviewStatus: "pending",
        },
      }, 202);
    }

    return json({
      success: true,
      verified: true,
      activated: activation.activated,
      alreadyActivated:
        activation.alreadyActivated,

      message:
        payment.productType === "advertisement"
          ? (activation.alreadyActivated
              ? "Payment verified successfully. Advertisement was already activated."
              : "Payment verified successfully and advertisement has been activated.")
          : payment.productType === "boost"
            ? (activation.alreadyActivated
                ? "Payment verified successfully. Boost was already activated."
                : "Payment verified successfully and boost has been activated.")
            : (activation.alreadyActivated
                ? "Payment verified successfully. Premium was already activated."
                : "Payment verified successfully and Premium has been activated."),

      payment: {
        transactionReference,
        productId:
          payment.productId,
        productType:
          payment.productType,
        amount:
          payment.amount,
        currency:
          payment.currency,
        channel:
          gatewayData.channel ||
          null,
        status:
          "paid",
      },

      ...(payment.productType === "advertisement"
        ? { campaign: activation.campaign }
        : payment.productType === "boost"
          ? { boost: activation.boost }
          : { subscription: activation.subscription }),
    });
  } catch (error) {
    console.error(
      "PAYSTACK VERIFY ERROR:",
      error
    );

    const message =
      error?.message ===
        "Authentication required" ||
      error?.message === "Invalid token" ||
      error?.message === "Token expired" ||
      error?.message ===
        "Invalid authentication token" ||
      error?.message === "Invalid user ID"
        ? error.message
        : "Failed to verify payment.";

    const status =
      message ===
        "Failed to verify payment."
        ? 500
        : 401;

    return json({
      success: false,
      message,
    }, status);
  }
}
