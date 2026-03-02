const CK_BASE_URL = 'https://www.nellobytesystems.com';
const https = require('https');
const { URL } = require('url');

const fetchFn =
  typeof fetch === 'function'
    ? fetch
    : (() => {
        try {
          return require('undici').fetch;
        } catch {
          return null;
        }
      })();

const cacheStore = new Map();

function cacheGet(key) {
  const hit = cacheStore.get(key);
  if (!hit) return null;
  if (hit.expires && hit.expires > Date.now()) return hit.value;
  cacheStore.delete(key);
  return null;
}

function cacheSet(key, value, ttlMs = 15 * 60_000) {
  cacheStore.set(key, { value, expires: Date.now() + Math.max(1_000, ttlMs) });
}

function getClubKonnectCreds() {
  const userId = String(process.env.CLUBKONNECT_USER_ID || '').trim();
  const apiKey = String(process.env.CLUBKONNECT_API_KEY || '').trim();
  if (!userId) throw new Error('Missing required env: CLUBKONNECT_USER_ID');
  if (!apiKey) throw new Error('Missing required env: CLUBKONNECT_API_KEY');
  return { userId, apiKey };
}

function httpsRequest(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method: 'GET',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => data,
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function ckGet(path, params) {
  const u = new URL(`${CK_BASE_URL}${path}`);
  const entries = Object.entries(params || {});
  for (const [k, v] of entries) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    u.searchParams.set(k, s);
  }

  const res = fetchFn ? await fetchFn(u.toString(), { method: 'GET' }) : await httpsRequest(u.toString());
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (res.ok && (json === null || (typeof json !== 'object' && !Array.isArray(json)))) {
    const err = new Error('ClubKonnect returned an invalid response');
    err.statusCode = 502;
    err.clubkonnect = { raw: String(text || '').slice(0, 800) };
    throw err;
  }

  if (!res.ok) {
    const msg = (json && (json.message || json.error)) ? (json.message || json.error) : (text || `ClubKonnect request failed (${res.status})`);
    const err = new Error(msg);
    err.statusCode = res.status;
    err.clubkonnect = json;
    throw err;
  }

  try {
    const sc = String(json?.statuscode ?? json?.StatusCode ?? '').trim();
    const status = String(json?.status ?? json?.orderstatus ?? json?.OrderStatus ?? '').trim().toUpperCase();

    const hardFailureByStatus =
      status.startsWith('AUTHENTICATION_FAILED') ||
      status.startsWith('INVALID_') ||
      status.startsWith('MISSING_');

    if (hardFailureByStatus) {
      const msg = String(json?.message || json?.orderremark || json?.OrderRemark || status || text || 'ClubKonnect provider error');
      const err = new Error(msg);
      err.statusCode = 400;
      err.clubkonnect = json;
      throw err;
    }

    if (sc && sc !== '100' && sc !== '200') {
      const looksLikeHardFailure =
        status.startsWith('INVALID_') ||
        status.startsWith('MISSING_') ||
        status.includes('CREDENTIAL') ||
        status.includes('ERROR') ||
        status.includes('FAILED');
      if (looksLikeHardFailure) {
        const msg = String(json?.message || json?.orderremark || json?.OrderRemark || status || text || 'ClubKonnect provider error');
        const err = new Error(msg);
        err.statusCode = 400;
        err.clubkonnect = json;
        throw err;
      }
    }
  } catch (e) {
    throw e;
  }

  return json;
}

function meterTypeToCode(meterType) {
  const t = String(meterType || '').trim().toLowerCase();
  return t === 'postpaid' || t === '02' ? '02' : '01';
}

async function listElectricityDiscosV2() {
  const userId = String(process.env.CLUBKONNECT_USER_ID || '').trim();
  const apiKey = String(process.env.CLUBKONNECT_API_KEY || '').trim();
  if (!userId) throw new Error('Missing required env: CLUBKONNECT_USER_ID');
  const params = { UserID: userId };
  if (apiKey) params.APIKey = apiKey;
  return await ckGet('/APIElectricityDiscosV2.asp', params);
}

async function verifyElectricityMeterV1({ electricCompany, meterNo, meterType }) {
  const { userId, apiKey } = getClubKonnectCreds();
  return await ckGet('/APIVerifyElectricityV1.asp', {
    UserID: userId,
    APIKey: apiKey,
    ElectricCompany: electricCompany,
    MeterNo: meterNo,
    MeterType: meterTypeToCode(meterType),
  });
}

async function payElectricityV1({ electricCompany, meterType, meterNo, amount, phoneNo, requestId, callbackUrl }) {
  const { userId, apiKey } = getClubKonnectCreds();
  return await ckGet('/APIElectricityV1.asp', {
    UserID: userId,
    APIKey: apiKey,
    ElectricCompany: electricCompany,
    MeterType: meterTypeToCode(meterType),
    MeterNo: meterNo,
    Amount: amount,
    PhoneNo: phoneNo,
    RequestID: requestId,
    CallBackURL: callbackUrl,
  });
}

async function queryTransactionV1({ orderId, requestId }) {
  const { userId, apiKey } = getClubKonnectCreds();
  const params = {
    UserID: userId,
    APIKey: apiKey,
  };
  if (orderId) params.OrderID = orderId;
  if (requestId) params.RequestID = requestId;
  return await ckGet('/APIQueryV1.asp', params);
}

async function cancelTransactionV1({ orderId }) {
  const { userId, apiKey } = getClubKonnectCreds();
  return await ckGet('/APICancelV1.asp', { UserID: userId, APIKey: apiKey, OrderID: orderId });
}

async function listDatabundlePlansV2() {
  const { userId, apiKey } = getClubKonnectCreds();
  return await ckGet('/APIDatabundlePlansV2.asp', { UserID: userId, APIKey: apiKey });
}

async function listDatabundlePlansV2Cached({ ttlMs = 30 * 60_000 } = {}) {
  const key = 'ck:databundle:plans:v2';
  const cached = cacheGet(key);
  if (cached) return cached;
  const plans = await listDatabundlePlansV2();
  cacheSet(key, plans, ttlMs);
  return plans;
}

async function buyAirtimeV1({ mobileNetwork, amount, mobileNumber, requestId, callbackUrl }) {
  const { userId, apiKey } = getClubKonnectCreds();
  return await ckGet('/APIAirtimeV1.asp', {
    UserID: userId,
    APIKey: apiKey,
    MobileNetwork: mobileNetwork,
    Amount: amount,
    MobileNumber: mobileNumber,
    RequestID: requestId,
    CallBackURL: callbackUrl,
  });
}

async function listCableTVPackagesV2() {
  const userId = String(process.env.CLUBKONNECT_USER_ID || '').trim();
  const apiKey = String(process.env.CLUBKONNECT_API_KEY || '').trim();
  if (!userId) throw new Error('Missing required env: CLUBKONNECT_USER_ID');
  const params = { UserID: userId };
  if (apiKey) params.APIKey = apiKey;
  return await ckGet('/APICableTVPackagesV2.asp', params);
}

async function listCableTVPackagesV2Cached({ ttlMs = 30 * 60_000 } = {}) {
  const key = 'ck:cable:packages:v2';
  const cached = cacheGet(key);
  if (cached) return cached;
  const json = await listCableTVPackagesV2();
  cacheSet(key, json, ttlMs);
  return json;
}

async function verifyCableTVV1({ cableTv, smartCardNo }) {
  const { userId, apiKey } = getClubKonnectCreds();
  return await ckGet('/APIVerifyCableTVV1.0.asp', {
    UserID: userId,
    APIKey: apiKey,
    CableTV: cableTv,
    SmartCardNo: smartCardNo,
  });
}

async function payCableTVV1({ cableTv, packageCode, smartCardNo, phoneNo, requestId, callbackUrl }) {
  const { userId, apiKey } = getClubKonnectCreds();
  return await ckGet('/APICableTVV1.asp', {
    UserID: userId,
    APIKey: apiKey,
    CableTV: cableTv,
    Package: packageCode,
    SmartCardNo: smartCardNo,
    PhoneNo: phoneNo,
    RequestID: requestId,
    CallBackURL: callbackUrl,
  });
}

async function buyDatabundleV1({ mobileNetwork, dataPlan, mobileNumber, requestId, callbackUrl }) {
  const { userId, apiKey } = getClubKonnectCreds();
  return await ckGet('/APIDatabundleV1.asp', {
    UserID: userId,
    APIKey: apiKey,
    MobileNetwork: mobileNetwork,
    DataPlan: dataPlan,
    MobileNumber: mobileNumber,
    RequestID: requestId,
    CallBackURL: callbackUrl,
  });
}

module.exports = {
  listElectricityDiscosV2,
  verifyElectricityMeterV1,
  payElectricityV1,
  queryTransactionV1,
  cancelTransactionV1,
  listDatabundlePlansV2,
  listDatabundlePlansV2Cached,
  buyAirtimeV1,
  buyDatabundleV1,
  listCableTVPackagesV2,
  listCableTVPackagesV2Cached,
  verifyCableTVV1,
  payCableTVV1,
  meterTypeToCode,
};
