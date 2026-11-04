import { ObjectId } from "mongodb";
import { authenticateAdmin } from "./adminBoosts.js";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function serializeCampaign(campaign) {
  if (!campaign) return null;

  return {
    ...campaign,
    _id: campaign._id?.toString?.() || campaign._id,
    advertiserId:
      campaign.advertiserId?.toString?.() || campaign.advertiserId,
    createdBy: campaign.createdBy?.toString?.() || campaign.createdBy,
    approvedBy: campaign.approvedBy?.toString?.() || campaign.approvedBy,
    rejectedBy: campaign.rejectedBy?.toString?.() || campaign.rejectedBy,
  };
}

function getErrorStatus(error) {
  return error.status || 500;
}

export async function getPendingAdvertisementCampaigns(
  request,
  env,
  db
) {
  try {
    const { adminUserId } = await authenticateAdmin(request, env, db);
    const url = new URL(request.url);

    const page = Math.max(
      1,
      Number.parseInt(url.searchParams.get("page") || "1", 10) || 1
    );

    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("limit") || "20", 10) || 20
      )
    );

    const filter = {
      status: "pending_approval",
      paymentStatus: "paid",
    };

    const skip = (page - 1) * limit;

    const [campaigns, total] = await Promise.all([
      db.collection("advertisement_campaigns")
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),

      db.collection("advertisement_campaigns").countDocuments(filter),
    ]);

    const advertiserIds = [
      ...new Map(
        campaigns
          .map(campaign => campaign.advertiserId)
          .filter(Boolean)
          .map(id => [id.toString(), id])
      ).values(),
    ];

    const advertisers = advertiserIds.length
      ? await db.collection("users")
          .find({ _id: { $in: advertiserIds } })
          .project({ _id: 1, name: 1, email: 1, profilePic: 1 })
          .toArray()
      : [];

    const advertiserMap = new Map(
      advertisers.map(user => [user._id.toString(), user])
    );

    const results = campaigns.map(campaign => {
      const advertiser = campaign.advertiserId
        ? advertiserMap.get(campaign.advertiserId.toString())
        : null;

      return {
        ...serializeCampaign(campaign),
        advertiser: advertiser
          ? {
              id: advertiser._id.toString(),
              name: advertiser.name || "",
              email: advertiser.email || "",
              profilePic: advertiser.profilePic || "",
            }
          : null,
      };
    });

    return json({
      success: true,
      campaigns: results,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      adminUserId: adminUserId.toString(),
    });
  } catch (error) {
    console.error("GET PENDING ADVERTISEMENTS ERROR:", error);

    return json(
      {
        success: false,
        error: error.message || "Failed to load pending advertisement campaigns.",
      },
      getErrorStatus(error)
    );
  }
}

export async function approveAdvertisementCampaign(
  request,
  env,
  db,
  campaignId
) {
  try {
    const { adminUserId } = await authenticateAdmin(request, env, db);

    if (!ObjectId.isValid(campaignId)) {
      return json({ success: false, error: "Invalid campaign ID." }, 400);
    }

    const campaigns = db.collection("advertisement_campaigns");
    const objectCampaignId = new ObjectId(campaignId);

    const campaign = await campaigns.findOne({
      _id: objectCampaignId,
    });

    if (!campaign) {
      return json({ success: false, error: "Advertisement campaign not found." }, 404);
    }

    if (
      campaign.status !== "pending_approval" ||
      campaign.paymentStatus !== "paid"
    ) {
      return json({
        success: false,
        error: "Only paid campaigns awaiting approval can be approved.",
      }, 409);
    }

    const durationDays = Number(campaign.durationDays);

    if (!Number.isInteger(durationDays) || durationDays <= 0) {
      return json({
        success: false,
        error: "Campaign has an invalid advertising duration.",
      }, 400);
    }

    const approvedAt = new Date();
    const endDate = new Date(approvedAt);
    endDate.setDate(endDate.getDate() + durationDays);

    const result = await campaigns.updateOne(
      {
        _id: objectCampaignId,
        status: "pending_approval",
        paymentStatus: "paid",
      },
      {
        $set: {
          status: "active",
          startDate: approvedAt,
          endDate,
          approvedBy: adminUserId,
          approvedAt,
          updatedAt: approvedAt,
        },
      }
    );

    if (result.modifiedCount !== 1) {
      return json({
        success: false,
        error: "Campaign approval failed or the campaign was already processed.",
      }, 409);
    }

    const updatedCampaign = await campaigns.findOne({
      _id: objectCampaignId,
    });

    if (!updatedCampaign || updatedCampaign.status !== "active") {
      return json({
        success: false,
        error: "Campaign approval could not be confirmed.",
      }, 500);
    }

    return json({
      success: true,
      message: "Advertisement campaign approved and activated successfully.",
      campaign: serializeCampaign(updatedCampaign),
    });
  } catch (error) {
    console.error("APPROVE ADVERTISEMENT CAMPAIGN ERROR:", error);

    return json(
      {
        success: false,
        error: error.message || "Failed to approve advertisement campaign.",
      },
      getErrorStatus(error)
    );
  }
}

export async function rejectAdvertisementCampaign(
  request,
  env,
  db,
  campaignId
) {
  try {
    const { adminUserId } = await authenticateAdmin(request, env, db);

    if (!ObjectId.isValid(campaignId)) {
      return json({ success: false, error: "Invalid campaign ID." }, 400);
    }

    let body = {};

    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const reason = String(body.reason || "").trim();

    if (!reason) {
      return json({
        success: false,
        error: "A rejection reason is required.",
      }, 400);
    }

    const objectCampaignId = new ObjectId(campaignId);
    const now = new Date();

    const result = await db.collection("advertisement_campaigns").updateOne(
      {
        _id: objectCampaignId,
        status: "pending_approval",
        paymentStatus: "paid",
      },
      {
        $set: {
          status: "rejected",
          rejectedBy: adminUserId,
          rejectedAt: now,
          rejectionReason: reason,
          updatedAt: now,
        },
      }
    );

    if (result.modifiedCount !== 1) {
      return json({
        success: false,
        error: "Campaign not found, not paid, or no longer awaiting approval.",
      }, 409);
    }

    const rejectedCampaign = await db.collection("advertisement_campaigns")
      .findOne({ _id: objectCampaignId });

    return json({
      success: true,
      message: "Advertisement campaign rejected. Its payment remains recorded and requires separate refund review.",
      campaign: serializeCampaign(rejectedCampaign),
      refundAutomatic: false,
    });
  } catch (error) {
    console.error("REJECT ADVERTISEMENT CAMPAIGN ERROR:", error);

    return json(
      {
        success: false,
        error: error.message || "Failed to reject advertisement campaign.",
      },
      getErrorStatus(error)
    );
  }
}
