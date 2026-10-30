import { ObjectId } from "mongodb";
import { getDatabase } from "../utils/db.js";
import {
  PRODUCT_TYPES,
  getProduct,
  getProductPrice,
  listProducts,
} from "../utils/products.js";

/*
 * ============================================================
 * AFRICSOCIAL ADVERTISEMENT ROUTES
 * ============================================================
 *
 * Responsibilities:
 *
 *   GET  /api/ads/products
 *   POST /api/ads/campaigns
 *   GET  /api/ads/campaigns
 *   GET  /api/ads/campaigns/:id
 *   POST /api/ads/campaigns/:id/cancel
 *
 * IMPORTANT:
 * - Product prices come from the backend product catalog.
 * - Never trust amount/price submitted by the frontend.
 * - Enterprise campaigns may use a custom amount, but must
 *   satisfy the product's minimum amount.
 * - Payment verification should happen separately.
 * ============================================================
 */


/* ============================================================
   RESPONSE HELPERS
   ============================================================ */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods":
      "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}


/* ============================================================
   AUTHENTICATION
   ============================================================ */

function getToken(request) {
  const auth =
    request.headers.get("Authorization") || "";

  if (!auth.startsWith("Bearer ")) {
    return null;
  }

  return auth.slice(7);
}

function base64UrlDecode(str) {
  str = str
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (str.length % 4) {
    str += "=";
  }

  return Uint8Array.from(
    atob(str),
    (c) => c.charCodeAt(0)
  );
}

async function verifyJWT(token, secret) {
  try {
    if (!token || !secret) {
      return null;
    }

    const parts = token.split(".");

    if (parts.length !== 3) {
      return null;
    }

    const [
      header,
      payload,
      signature,
    ] = parts;

    const data = new TextEncoder().encode(
      `${header}.${payload}`
    );

    const key =
      await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        {
          name: "HMAC",
          hash: "SHA-256",
        },
        false,
        ["verify"]
      );

    const valid =
      await crypto.subtle.verify(
        "HMAC",
        key,
        base64UrlDecode(signature),
        data
      );

    if (!valid) {
      return null;
    }

    return JSON.parse(
      new TextDecoder().decode(
        base64UrlDecode(payload)
      )
    );
  } catch {
    return null;
  }
}

async function authenticate(
  request,
  env,
  db
) {
  const token = getToken(request);

  if (!token) {
    return null;
  }

  const payload =
    await verifyJWT(
      token,
      env.JWT_SECRET || env.JWT_KEY
    );

  if (!payload) {
    return null;
  }

  const userId =
    payload.id ||
    payload._id ||
    payload.userId ||
    payload.sub;

  if (
    !userId ||
    !ObjectId.isValid(String(userId))
  ) {
    return null;
  }

  const user =
    await db.collection("users").findOne(
      {
        _id: new ObjectId(
          String(userId)
        ),
      },
      {
        projection: {
          password: 0,
          verifyToken: 0,
          resetToken: 0,
          resetTokenExpiry: 0,
        },
      }
    );

  return user || null;
}


/* ============================================================
   HELPERS
   ============================================================ */

function serializeCampaign(campaign) {
  if (!campaign) {
    return campaign;
  }

  return {
    ...campaign,

    _id:
      campaign._id?.toString?.() ||
      campaign._id,

    advertiserId:
      campaign.advertiserId?.toString?.() ||
      campaign.advertiserId,

    createdBy:
      campaign.createdBy?.toString?.() ||
      campaign.createdBy,

    targetUserIds:
      Array.isArray(campaign.targetUserIds)
        ? campaign.targetUserIds.map(
            (id) =>
              id?.toString?.() || id
          )
        : [],
  };
}

function isOwner(campaign, user) {
  return (
    campaign?.advertiserId &&
    user?._id &&
    String(campaign.advertiserId) ===
      String(user._id)
  );
}

function isAdmin(user) {
  return user?.role === "admin";
}


/*
 * PUBLIC PAID ADVERTISEMENT DELIVERY
 * GET /api/ads/delivery
 *
 * Restricted-target campaigns are excluded until viewer matching
 * is implemented. This endpoint does not count impressions.
 */
export async function getDeliverableAdvertisementCampaigns(
  request,
  env,
  db
) {
  try {
    const now = new Date();
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") || 5);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(10, Math.max(1, Math.floor(requestedLimit)))
      : 5;

    const filter = {
      status: "active",
      paymentStatus: "paid",
      startDate: { $lte: now },
      endDate: { $gt: now },
      "target.country": { $in: ["", null] },
      "target.state": { $in: ["", null] },
      "target.city": { $in: ["", null] },
      "target.gender": { $in: ["all", "", null] },
      "target.ageMin": { $in: [18, null] },
      "target.ageMax": { $in: [65, null] },
    };

    const campaigns = await db
      .collection("advertisement_campaigns")
      .find(filter, {
        projection: {
          _id: 1,
          title: 1,
          description: 1,
          mediaUrl: 1,
          destinationUrl: 1,
          cta: 1,
          productName: 1,
          createdAt: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    const publicCampaigns = campaigns.map((campaign) => ({
      id: String(campaign._id),
      label: "Sponsored",
      title: typeof campaign.title === "string" ? campaign.title : "",
      description:
        typeof campaign.description === "string"
          ? campaign.description
          : "",
      mediaUrl:
        typeof campaign.mediaUrl === "string"
          ? campaign.mediaUrl
          : "",
      destinationUrl:
        typeof campaign.destinationUrl === "string"
          ? campaign.destinationUrl
          : "",
      cta: typeof campaign.cta === "string" ? campaign.cta : "Learn more",
      productName:
        typeof campaign.productName === "string"
          ? campaign.productName
          : "",
    }));

    return json({ success: true, campaigns: publicCampaigns });
  } catch (error) {
    console.error(
      "ADVERTISEMENT DELIVERY ERROR:",
      error?.name || "UnknownError"
    );

    return json(
      {
        success: false,
        message: "Unable to load sponsored campaigns.",
        campaigns: [],
      },
      500
    );
  }
}

/* ============================================================
   GET ADVERTISEMENT PRODUCTS
   ============================================================
 *
 * GET /api/ads/products
 *
 * Optional:
 *
 *   ?currency=NGN
 *
 * Returns advertisement products only.
 * ============================================================
 */

export async function getAdvertisementProducts(
  request,
  env,
  db
) {
  try {
    const url =
      new URL(request.url);

    const currency =
      String(
        url.searchParams.get(
          "currency"
        ) || "NGN"
      ).toUpperCase();

    const products =
      listProducts({
        type:
          PRODUCT_TYPES.ADVERTISEMENT,
        currency,
      });

    return json({
      success: true,
      currency,
      products,
    });
  } catch (err) {
    console.error(
      "GET ADVERTISEMENT PRODUCTS ERROR:",
      err
    );

    return json(
      {
        success: false,
        message:
          "Failed to load advertisement products.",
      },
      500
    );
  }
}


/* ============================================================
   CREATE ADVERTISEMENT CAMPAIGN
   ============================================================
 *
 * POST /api/ads/campaigns
 *
 * Expected body:
 *
 * {
 *   "productId": "ad_business_growth",
 *   "title": "My Campaign",
 *   "description": "Campaign description",
 *   "mediaUrl": "https://...",
 *   "destinationUrl": "https://...",
 *   "cta": "Learn More",
 *   "target": {
 *     "country": "Nigeria",
 *     "state": "Lagos",
 *     "gender": "all",
 *     "ageMin": 18,
 *     "ageMax": 65
 *   }
 * }
 *
 * Enterprise:
 *
 * {
 *   "productId": "ad_enterprise",
 *   "customAmount": 150000,
 *   ...
 * }
 *
 * ============================================================
 */

export async function createAdvertisementCampaign(
  request,
  env,
  db
) {
  try {
    const user =
      await authenticate(
        request,
        env,
        db
      );

    if (!user) {
      return json(
        {
          success: false,
          message:
            "Authentication required.",
        },
        401
      );
    }

    const body =
      await request.json();

    const productId =
      String(
        body?.productId || ""
      ).trim();

    if (!productId) {
      return json(
        {
          success: false,
          message:
            "Advertisement product is required.",
        },
        400
      );
    }

    const product =
      getProduct(productId);

    if (!product) {
      return json(
        {
          success: false,
          message:
            "Advertisement product not found.",
        },
        400
      );
    }

    if (
      product.type !==
      PRODUCT_TYPES.ADVERTISEMENT
    ) {
      return json(
        {
          success: false,
          message:
            "The selected product is not an advertisement product.",
        },
        400
      );
    }


    /* ========================================================
       BASIC CAMPAIGN INFORMATION
       ======================================================== */

    const title =
      String(
        body?.title || ""
      ).trim();

    const description =
      String(
        body?.description || ""
      ).trim();

    const mediaUrl =
      String(
        body?.mediaUrl || ""
      ).trim();

    const destinationUrl =
      String(
        body?.destinationUrl || ""
      ).trim();

    const cta =
      String(
        body?.cta || "Learn More"
      ).trim();

    if (!title) {
      return json(
        {
          success: false,
          message:
            "Campaign title is required.",
        },
        400
      );
    }

    if (title.length > 150) {
      return json(
        {
          success: false,
          message:
            "Campaign title is too long.",
        },
        400
      );
    }

    if (!description) {
      return json(
        {
          success: false,
          message:
            "Campaign description is required.",
        },
        400
      );
    }

    if (description.length > 2000) {
      return json(
        {
          success: false,
          message:
            "Campaign description is too long.",
        },
        400
      );
    }

    if (!mediaUrl) {
      return json(
        {
          success: false,
          message:
            "Advertisement media is required.",
        },
        400
      );
    }


    /* ========================================================
       DESTINATION URL
       ======================================================== */

    if (destinationUrl) {
      try {
        const parsed =
          new URL(destinationUrl);

        if (
          !["http:", "https:"].includes(
            parsed.protocol
          )
        ) {
          return json(
            {
              success: false,
              message:
                "Destination URL must use HTTP or HTTPS.",
            },
            400
          );
        }
      } catch {
        return json(
          {
            success: false,
            message:
              "Invalid destination URL.",
          },
          400
        );
      }
    }


    /* ========================================================
       PRICE
       ========================================================
 *
 * NEVER trust:
 *
 *   body.amount
 *   body.price
 *
 * Fixed products:
 *
 *   price = catalog price
 *
 * Enterprise:
 *
 *   customAmount >= minimumAmount
 *
 * ======================================================== */

    let amount;

    if (
      product.customAmountAllowed === true
    ) {
      const customAmount =
        Number(
          body?.customAmount
        );

      const minimumAmount =
        Number(
          product.minimumAmount || 0
        );

      if (
        !Number.isFinite(
          customAmount
        ) ||
        customAmount < minimumAmount
      ) {
        return json(
          {
            success: false,
            code:
              "INVALID_CUSTOM_AMOUNT",
            message:
              `Enterprise campaigns require a minimum amount of ${minimumAmount.toLocaleString(
                "en-NG"
              )} NGN.`,
            minimumAmount,
            currency: "NGN",
          },
          400
        );
      }

      amount = customAmount;
    } else {
      amount =
        getProductPrice(
          productId,
          "NGN"
        );

      if (
        !Number.isFinite(amount)
      ) {
        return json(
          {
            success: false,
            message:
              "Advertisement price is not available.",
          },
          400
        );
      }
    }


    /* ========================================================
       TARGETING
       ======================================================== */

    const target =
      body?.target &&
      typeof body.target ===
        "object"
        ? body.target
        : {};

    const ageMin =
      Number.isFinite(
        Number(target.ageMin)
      )
        ? Number(target.ageMin)
        : 18;

    const ageMax =
      Number.isFinite(
        Number(target.ageMax)
      )
        ? Number(target.ageMax)
        : 65;

    if (
      ageMin < 13 ||
      ageMin > 100 ||
      ageMax < 13 ||
      ageMax > 100 ||
      ageMin > ageMax
    ) {
      return json(
        {
          success: false,
          message:
            "Invalid target age range.",
        },
        400
      );
    }

    const normalizedTarget = {
      country:
        String(
          target.country || ""
        ).trim(),

      state:
        String(
          target.state || ""
        ).trim(),

      city:
        String(
          target.city || ""
        ).trim(),

      gender:
        String(
          target.gender || "all"
        ).trim().toLowerCase(),

      ageMin,
      ageMax,
    };

    const allowedGenders = [
      "all",
      "male",
      "female",
    ];

    if (
      !allowedGenders.includes(
        normalizedTarget.gender
      )
    ) {
      normalizedTarget.gender =
        "all";
    }


    /* ========================================================
       DURATION
       ======================================================== */

    const durationDays =
      Number(
        product.durationDays
      );

    if (
      !Number.isFinite(
        durationDays
      ) ||
      durationDays <= 0
    ) {
      return json(
        {
          success: false,
          message:
            "Invalid advertisement duration.",
        },
        400
      );
    }

    const now =
      new Date();

    const endDate =
      new Date(now);

    endDate.setDate(
      endDate.getDate() +
        durationDays
    );


    /* ========================================================
       CAMPAIGN DOCUMENT
       ======================================================== */

    const campaign = {
      advertiserId:
        user._id,

      createdBy:
        user._id,

      productId:
        product.id,

      productName:
        product.name,

      productType:
        product.type,

      title,

      description,

      mediaUrl,

      destinationUrl,

      cta,

      target:
        normalizedTarget,

      currency:
        "NGN",

      amount,

      durationDays,

      status:
        "pending_payment",

      paymentStatus:
        "unpaid",

      paymentReference:
        null,

      startDate:
        null,

      endDate:
        null,

      impressions:
        0,

      clicks:
        0,

      views:
        0,

      createdAt:
        now,

      updatedAt:
        now,
    };

    const result =
      await db
        .collection(
          "advertisement_campaigns"
        )
        .insertOne(
          campaign
        );

    campaign._id =
      result.insertedId;

    return json(
      {
        success: true,

        message:
          "Advertisement campaign created. Payment is required before activation.",

        campaign:
          serializeCampaign(
            campaign
          ),
      },
      201
    );
  } catch (err) {
    console.error(
      "CREATE ADVERTISEMENT CAMPAIGN ERROR:",
      err
    );

    return json(
      {
        success: false,
        message:
          "Failed to create advertisement campaign.",
      },
      500
    );
  }
}


/* ============================================================
   GET MY ADVERTISEMENT CAMPAIGNS
   ============================================================
 *
 * GET /api/ads/campaigns
 *
 * ============================================================
 */

export async function getAdvertisementCampaigns(
  request,
  env,
  db
) {
  try {
    const user =
      await authenticate(
        request,
        env,
        db
      );

    if (!user) {
      return json(
        {
          success: false,
          message:
            "Authentication required.",
        },
        401
      );
    }

    const campaigns =
      await db
        .collection(
          "advertisement_campaigns"
        )
        .find({
          advertiserId:
            user._id,
        })
        .sort({
          createdAt: -1,
        })
        .toArray();

    return json({
      success: true,
      campaigns:
        campaigns.map(
          serializeCampaign
        ),
    });
  } catch (err) {
    console.error(
      "GET ADVERTISEMENT CAMPAIGNS ERROR:",
      err
    );

    return json(
      {
        success: false,
        message:
          "Failed to load advertisement campaigns.",
      },
      500
    );
  }
}


/* ============================================================
   GET SINGLE CAMPAIGN
   ============================================================
 *
 * GET /api/ads/campaigns/:id
 *
 * ============================================================
 */

export async function getAdvertisementCampaign(
  request,
  env,
  db,
  id
) {
  try {
    const user =
      await authenticate(
        request,
        env,
        db
      );

    if (!user) {
      return json(
        {
          success: false,
          message:
            "Authentication required.",
        },
        401
      );
    }

    if (
      !ObjectId.isValid(id)
    ) {
      return json(
        {
          success: false,
          message:
            "Campaign not found.",
        },
        404
      );
    }

    const campaign =
      await db
        .collection(
          "advertisement_campaigns"
        )
        .findOne({
          _id:
            new ObjectId(id),
        });

    if (!campaign) {
      return json(
        {
          success: false,
          message:
            "Campaign not found.",
        },
        404
      );
    }

    if (
      !isOwner(
        campaign,
        user
      ) &&
      !isAdmin(user)
    ) {
      return json(
        {
          success: false,
          message:
            "Unauthorized.",
        },
        403
      );
    }

    return json({
      success: true,
      campaign:
        serializeCampaign(
          campaign
        ),
    });
  } catch (err) {
    console.error(
      "GET ADVERTISEMENT CAMPAIGN ERROR:",
      err
    );

    return json(
      {
        success: false,
        message:
          "Failed to load advertisement campaign.",
      },
      500
    );
  }
}


/* ============================================================
   CANCEL CAMPAIGN
   ============================================================
 *
 * POST /api/ads/campaigns/:id/cancel
 *
 * Only unpaid/pending campaigns can be cancelled by the
 * advertiser at this stage.
 *
 * ============================================================
 */

export async function cancelAdvertisementCampaign(
  request,
  env,
  db,
  id
) {
  try {
    const user =
      await authenticate(
        request,
        env,
        db
      );

    if (!user) {
      return json(
        {
          success: false,
          message:
            "Authentication required.",
        },
        401
      );
    }

    if (
      !ObjectId.isValid(id)
    ) {
      return json(
        {
          success: false,
          message:
            "Campaign not found.",
        },
        404
      );
    }

    const campaign =
      await db
        .collection(
          "advertisement_campaigns"
        )
        .findOne({
          _id:
            new ObjectId(id),
        });

    if (!campaign) {
      return json(
        {
          success: false,
          message:
            "Campaign not found.",
        },
        404
      );
    }

    if (
      !isOwner(
        campaign,
        user
      ) &&
      !isAdmin(user)
    ) {
      return json(
        {
          success: false,
          message:
            "Unauthorized.",
        },
        403
      );
    }

    if (
      campaign.status !==
      "pending_payment"
    ) {
      return json(
        {
          success: false,
          message:
            "Only campaigns awaiting payment can be cancelled.",
        },
        400
      );
    }

    const cancelResult = await db
      .collection("advertisement_campaigns")
      .updateOne(
        {
          _id: campaign._id,
          status: "pending_payment",
          paymentStatus: "unpaid",
          paymentReference: null,
        },
        {
          $set: {
            status: "cancelled",
            updatedAt: new Date(),
          },
        },
      );

    if (cancelResult.modifiedCount !== 1) {
      return json(
        {
          success: false,
          code: "CAMPAIGN_CHECKOUT_IN_PROGRESS",
          message:
            "This campaign has a payment in progress or its status has changed. Please refresh and check its payment status.",
        },
        409,
      );
    }

    return json({
      success: true,
      message:
        "Advertisement campaign cancelled.",
    });
  } catch (err) {
    console.error(
      "CANCEL ADVERTISEMENT CAMPAIGN ERROR:",
      err
    );

    return json(
      {
        success: false,
        message:
          "Failed to cancel advertisement campaign.",
      },
      500
    );
  }
}