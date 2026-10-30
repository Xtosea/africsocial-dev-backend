import test from "node:test";
import assert from "node:assert/strict";

import {
  getDeliverableAdvertisementCampaigns,
} from "../worker/routes/advertisements.js";

function makeDb(campaigns = [], fail = false) {
  let filterSeen;
  let optionsSeen;
  let limitSeen;

  const cursor = {
    sort(value) {
      assert.deepEqual(value, { createdAt: -1 });
      return this;
    },
    limit(value) {
      limitSeen = value;
      return this;
    },
    async toArray() {
      if (fail) throw new Error("private database failure detail");
      return campaigns;
    },
  };

  return {
    collection(name) {
      assert.equal(name, "advertisement_campaigns");
      return {
        find(filter, options) {
          filterSeen = filter;
          optionsSeen = options;
          return cursor;
        },
      };
    },
    inspect() {
      return { filterSeen, optionsSeen, limitSeen };
    },
  };
}

test("delivery exposes only the approved public campaign fields", async () => {
  const db = makeDb([{
    _id: "campaign-123",
    title: "Example campaign",
    description: "Example description",
    mediaUrl: "https://media.example/ad.jpg",
    destinationUrl: "https://example.com",
    cta: "Learn more",
    productName: "Local Starter",
    advertiserId: "private-advertiser-id",
    paymentReference: "private-payment-reference",
    amount: 2000,
    internalNotes: "must not be exposed",
  }]);

  const response = await getDeliverableAdvertisementCampaigns(
    new Request("https://example.com/api/ads/delivery"),
    {},
    db
  );

  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.success, true);
  assert.deepEqual(body.campaigns[0], {
    id: "campaign-123",
    label: "Sponsored",
    title: "Example campaign",
    description: "Example description",
    mediaUrl: "https://media.example/ad.jpg",
    destinationUrl: "https://example.com",
    cta: "Learn more",
    productName: "Local Starter",
  });

  assert.doesNotMatch(JSON.stringify(body), /private-advertiser-id/);
  assert.doesNotMatch(JSON.stringify(body), /private-payment-reference/);
  assert.doesNotMatch(JSON.stringify(body), /internalNotes/);
});

test("delivery filters for paid, active campaigns within their dates", async () => {
  const db = makeDb([]);

  await getDeliverableAdvertisementCampaigns(
    new Request("https://example.com/api/ads/delivery"),
    {},
    db
  );

  const { filterSeen: f, optionsSeen: o } = db.inspect();

  assert.equal(f.status, "active");
  assert.equal(f.paymentStatus, "paid");
  assert.ok(f.startDate.$lte instanceof Date);
  assert.ok(f.endDate.$gt instanceof Date);

  assert.deepEqual(f["target.country"], { $in: ["", null] });
  assert.deepEqual(f["target.state"], { $in: ["", null] });
  assert.deepEqual(f["target.city"], { $in: ["", null] });
  assert.deepEqual(f["target.gender"], { $in: ["all", "", null] });
  assert.deepEqual(f["target.ageMin"], { $in: [18, null] });
  assert.deepEqual(f["target.ageMax"], { $in: [65, null] });

  assert.deepEqual(o.projection, {
    _id: 1,
    title: 1,
    description: 1,
    mediaUrl: 1,
    destinationUrl: 1,
    cta: 1,
    productName: 1,
    createdAt: 1,
  });
});

test("delivery caps the requested result limit at ten", async () => {
  const db = makeDb([]);

  const response = await getDeliverableAdvertisementCampaigns(
    new Request("https://example.com/api/ads/delivery?limit=100"),
    {},
    db
  );

  assert.equal(response.status, 200);
  assert.equal(db.inspect().limitSeen, 10);
});

test("delivery hides database errors from public responses", async () => {
  const db = makeDb([], true);

  const response = await getDeliverableAdvertisementCampaigns(
    new Request("https://example.com/api/ads/delivery"),
    {},
    db
  );

  assert.equal(response.status, 500);
  const body = await response.json();

  assert.equal(body.success, false);
  assert.deepEqual(body.campaigns, []);
  assert.doesNotMatch(
    JSON.stringify(body),
    /private database failure detail/
  );
});
