// Campaign targeting + FCM payload shape.
//
// The expensive failure here is a mis-parsed audience: "users" silently
// degrading to "all" mails every customer on the platform, and there is no
// unsend. The second check is the image plumbing - FCM ignores an image set on
// the wrong key and just delivers a text banner, which looks like it worked.

const assert = require('assert');

process.env.PII_HASH_KEY = process.env.PII_HASH_KEY || 'a'.repeat(64);
process.env.PII_ENC_KEY = process.env.PII_ENC_KEY || 'b'.repeat(64);

const { parseAudience, recipientsWhereFor } = require('../src/controllers/adminNotificationCampaigns.controller');
const { buildMessage } = require('../src/services/fcm.service');

// --- audience parsing -------------------------------------------------------

assert.deepStrictEqual(parseAudience({}), { audience: 'all', audience_value: null });
assert.deepStrictEqual(parseAudience({ audience: 'ALL' }), { audience: 'all', audience_value: null });

assert.deepStrictEqual(
  parseAudience({ audience: 'topic', topic: 'all_android' }),
  { audience: 'topic', audience_value: { topic: 'all_android' } }
);

// Comma string from the dashboard input, and an array from an API client:
// both must land as deduped positive integers.
assert.deepStrictEqual(
  parseAudience({ audience: 'users', user_ids: ' 12, 48 ,12, 199 ' }),
  { audience: 'users', audience_value: { user_ids: [12, 48, 199] } }
);
assert.deepStrictEqual(
  parseAudience({ audience: 'users', user_ids: [7, '9'] }),
  { audience: 'users', audience_value: { user_ids: [7, 9] } }
);

// Anything unusable is null so the caller 400s. None of these may become "all".
assert.strictEqual(parseAudience({ audience: 'users', user_ids: '' }), null);
assert.strictEqual(parseAudience({ audience: 'users', user_ids: 'abc, -3, 0' }), null);
assert.strictEqual(parseAudience({ audience: 'topic', topic: '' }), null);
assert.strictEqual(parseAudience({ audience: 'topic', topic: 'bad topic name' }), null);
assert.strictEqual(parseAudience({ audience: 'everyone' }), null);

// --- audience -> prisma where ----------------------------------------------

assert.deepStrictEqual(recipientsWhereFor({ audience: 'all' }), { status: 1 });
assert.deepStrictEqual(
  recipientsWhereFor({ audience: 'users', audience_value: { user_ids: [3, 4] } }),
  { status: 1, id: { in: [3, 4] } }
);
// An empty list must match nobody, never everybody.
assert.deepStrictEqual(
  recipientsWhereFor({ audience: 'users', audience_value: { user_ids: [] } }),
  { status: 1, id: { in: [0] } }
);

// --- FCM payload ------------------------------------------------------------

const plain = buildMessage({ title: 'Hi', body: 'There', data: { campaign_id: 4 } });
assert.strictEqual(plain.notification.image, undefined);
assert.strictEqual(plain.android.notification.imageUrl, undefined);
// FCM rejects non-string data values.
assert.strictEqual(plain.data.campaign_id, '4');
assert.strictEqual(plain.android.notification.channelId, 'voltpay_alerts');

const rich = buildMessage({ title: 'Hi', body: 'There', image: ' https://cdn.example.com/a.png ' });
assert.strictEqual(rich.notification.image, 'https://cdn.example.com/a.png');
assert.strictEqual(rich.android.notification.imageUrl, 'https://cdn.example.com/a.png');
assert.strictEqual(rich.apns.fcmOptions.imageUrl, 'https://cdn.example.com/a.png');
// iOS only renders an attachment when the payload is mutable.
assert.strictEqual(rich.apns.payload.aps['mutable-content'], 1);

// http:// and data: URLs are dropped - FCM fetches the image on the device and
// a non-https source fails there, invisibly.
assert.strictEqual(buildMessage({ title: 'a', body: 'b', image: 'http://x/a.png' }).notification.image, undefined);
assert.strictEqual(buildMessage({ title: 'a', body: 'b', image: 'not a url' }).notification.image, undefined);

console.log('notificationCampaign: all assertions passed');
