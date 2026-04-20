const prisma = require('../../database/prisma');
const bcrypt = require('bcryptjs');

const { buyAirtimeV1, buyDatabundleV1, listDatabundlePlansV2Cached } = require('../funding/clubkonnect.service');

const MIN_QUALIFYING_AMOUNT = 100;
const AIRTIME_TARGET = 10;
const DATA_TARGET = 7;

const AIRTIME_REWARD_AMOUNT = 200;

const POINTS_PER_AIRTIME = 10;
const POINTS_PER_DATA = 10;

const CLAIM_START_DAY = 6; // Saturday
const CLAIM_START_HOUR = 0; // 00:00
const CLAIM_WINDOW_HOURS = 24;

function lagosParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(d);
  const out = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: String(out.weekday || ''),
  };
}

async function history(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const rows = await prisma.billHeroClaim.findMany({
      where: {
        user_id: Number(user.id),
      },
      orderBy: [{ claimed_at: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        week_key: true,
        reward_type: true,
        phone: true,
        network: true,
        status: true,
        provider_ref: true,
        claimed_at: true,
      },
    });

    return res.json({
      remark: 'bill_hero_history',
      status: 'success',
      message: ['OK'],
      data: {
        history: rows.map((r) => ({
          id: Number(r.id),
          week_key: String(r.week_key || ''),
          reward_type: String(r.reward_type || ''),
          phone: String(r.phone || ''),
          network: String(r.network || ''),
          status: String(r.status || ''),
          provider_ref: r.provider_ref ? String(r.provider_ref) : '',
          claimed_at: r.claimed_at instanceof Date ? r.claimed_at.toISOString() : new Date(r.claimed_at).toISOString(),
        })),
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

function lagosNowUtcDate() {
  const p = lagosParts(new Date());
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0));
}

function startOfWeekLagosUtc(d) {
  const x = new Date(d.getTime());
  x.setUTCHours(0, 0, 0, 0);
  const day = x.getUTCDay();
  const diff = (day + 6) % 7; // Monday => 0
  x.setUTCDate(x.getUTCDate() - diff);
  return x;
}

function isoWeekKey(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const weekNo =
    1 +
    Math.round(
      ((date - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7
    );
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function claimWindowForWeek(weekStart) {
  const start = new Date(weekStart.getTime());
  start.setUTCDate(start.getUTCDate() + 5); // Saturday
  start.setUTCHours(CLAIM_START_HOUR, 0, 0, 0);
  const end = new Date(start.getTime() + CLAIM_WINDOW_HOURS * 60 * 60 * 1000);
  return { start, end };
}

function ckNetworkFromName(network) {
  const n = String(network || '').trim().toUpperCase();
  if (n === 'MTN') return '01';
  if (n === 'GLO') return '02';
  if (n === '9MOBILE' || n === '9 MOBILE' || n === 'ETISALAT') return '03';
  if (n === 'AIRTEL') return '04';
  return '';
}

function normalizeClubKonnectMobileNumberNg(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length === 11) return digits;
  if (digits.startsWith('234') && digits.length === 13) return `0${digits.substring(3)}`;
  if (!digits.startsWith('0') && digits.length === 10) return `0${digits}`;
  if (!digits.startsWith('0') && digits.length === 11) return digits;
  return digits;
}

function pickPlansForNetwork(rawPlans, ckNetworkCode) {
  if (!rawPlans) return [];
  const root = rawPlans?.data || rawPlans?.plans || rawPlans;

  try {
    const mobileNetwork =
      root?.MOBILE_NETWORK ||
      root?.mobile_network ||
      root?.MobileNetwork ||
      root?.mobileNetwork ||
      root?.Mobile_Network;
    if (mobileNetwork && typeof mobileNetwork === 'object' && !Array.isArray(mobileNetwork)) {
      const keys = Object.keys(mobileNetwork);
      const norm = v => String(v || '').trim().toUpperCase();
      const findKey = predicate => keys.find(k => predicate(norm(k)));

      let foundKey = null;
      if (ckNetworkCode === '01') {
        foundKey = findKey(v => v.includes('MTN'));
      } else if (ckNetworkCode === '02') {
        foundKey = findKey(v => v.includes('GLO'));
      } else if (ckNetworkCode === '03') {
        foundKey = findKey(v => v.includes('9MOBILE') || v.includes('9 MOBILE') || v.includes('ETISALAT') || v.startsWith('9'));
      } else if (ckNetworkCode === '04') {
        foundKey = findKey(v => v.includes('AIRTEL'));
      }

      const picked = foundKey ? mobileNetwork[foundKey] : null;

      const flattenProducts = arr => {
        if (!Array.isArray(arr)) return [];
        const out = [];
        for (const g of arr) {
          if (g && typeof g === 'object') {
            const p = g.PRODUCT || g.product || g.Products || g.products;
            if (Array.isArray(p)) {
              out.push(...p);
              continue;
            }
          }
          out.push(g);
        }
        return out;
      };

      if (Array.isArray(picked)) {
        return flattenProducts(picked);
      }
      if (picked && typeof picked === 'object') {
        const p = picked.PRODUCT || picked.product || picked.Products || picked.products;
        if (Array.isArray(p)) return p;
      }
    }
  } catch (_) {}

  try {
    if (root && typeof root === 'object' && Array.isArray(root?.[ckNetworkCode])) {
      return root[ckNetworkCode];
    }
  } catch (_) {}

  const candidates = [];
  if (ckNetworkCode === '01') candidates.push(root?.MTN, root?.mtn, root?.Mtn);
  if (ckNetworkCode === '02') candidates.push(root?.GLO, root?.Glo, root?.glo);
  if (ckNetworkCode === '03') candidates.push(root?.['9MOBILE'], root?.['9mobile'], root?.['9Mobile'], root?.ETISALAT, root?.Etisalat, root?.etisalat);
  if (ckNetworkCode === '04') candidates.push(root?.AIRTEL, root?.Airtel, root?.airtel);

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  if (Array.isArray(root)) {
    const hasNetworkField = root.some(p => p && typeof p === 'object' && (p.MobileNetwork || p.mobilenetwork || p.network || p.network_code || p.networkCode));
    if (hasNetworkField) {
      return root.filter(p => {
        const v = String(p?.MobileNetwork ?? p?.mobilenetwork ?? p?.network ?? p?.network_code ?? p?.networkCode ?? '').trim();
        return v === String(ckNetworkCode);
      });
    }
    return root;
  }

  return [];
}

function normalizePlan(plan, idx) {
  const rawProductId =
    plan?.PRODUCT_ID ??
    plan?.product_id ??
    plan?.ProductID ??
    plan?.productId ??
    plan?.id ??
    plan?.planid ??
    plan?.PlanID ??
    plan?.dataplan ??
    plan?.DataPlan;
  const cleanedProductId = String(rawProductId ?? '').trim().replace(/\.0$/, '');
  const id = cleanedProductId || rawProductId || idx + 1;

  const item_code = cleanedProductId || String(rawProductId ?? '').trim() || String(id);
  const name =
    String(
      plan?.PRODUCT_NAME ??
        plan?.product_name ??
        plan?.ProductName ??
        plan?.productName ??
        plan?.name ??
        plan?.plan ??
        plan?.PlanName ??
        plan?.dataplanname ??
        plan?.DataPlanName ??
        '',
    ).trim() || 'Data Bundle';

  const rawAmount =
    plan?.PRODUCT_AMOUNT ??
    plan?.product_amount ??
    plan?.ProductAmount ??
    plan?.productAmount ??
    plan?.amount ??
    plan?.price ??
    plan?.Amount ??
    plan?.Price ??
    plan?.amount_ngn ??
    0;
  const amountStr = String(rawAmount ?? '').trim();
  const cleanedAmount = amountStr ? amountStr.replace(/[^0-9.]/g, '') : '';
  const amount = Number(cleanedAmount || rawAmount || 0);

  return {
    item_code,
    name,
    amount: Number.isFinite(amount) ? amount : 0,
  };
}

function parseSizeMb(name) {
  const s = String(name || '');
  const gb = /([0-9]+(?:\.[0-9]+)?)\s*gb/i.exec(s);
  if (gb) {
    const v = Number(gb[1]);
    if (Number.isFinite(v)) return Math.round(v * 1024);
  }
  const mb = /\b([0-9]{2,5})\s*mb\b/i.exec(s);
  if (mb) {
    const v = Number(mb[1]);
    if (Number.isFinite(v)) return Math.round(v);
  }
  return null;
}

function pickBest1GbPlan(plans) {
  const normalized = (Array.isArray(plans) ? plans : [])
    .map((p, idx) => normalizePlan(p, idx))
    .filter(x => String(x.item_code || '').trim() && Number(x.amount || 0) > 0);

  const enriched = normalized.map(p => {
    const mb = parseSizeMb(p.name);
    return { ...p, sizeMb: mb };
  });

  const targetMb = 1024;

  const candidates = enriched
    .filter(p => {
      const name = String(p.name || '').toLowerCase();
      if (name.includes('night') || name.includes('midnight') || name.includes('weekly') || name.includes('2gb') || name.includes('3gb')) {
        // do not hard-exclude weekly; keep selection simple and size-based when possible
      }
      if (p.sizeMb != null) {
        return p.sizeMb >= 900 && p.sizeMb <= 1150;
      }
      return /\b1\s*gb\b/i.test(p.name) || /\b1024\s*mb\b/i.test(p.name) || /\b1000\s*mb\b/i.test(p.name);
    });

  const pool = candidates.length ? candidates : enriched;
  if (!pool.length) return null;

  pool.sort((a, b) => {
    const aDiff = a.sizeMb != null ? Math.abs(a.sizeMb - targetMb) : 999999;
    const bDiff = b.sizeMb != null ? Math.abs(b.sizeMb - targetMb) : 999999;
    if (aDiff !== bDiff) return aDiff - bDiff;
    // prefer cheaper if same size diff
    const aAmt = Number(a.amount || 0);
    const bAmt = Number(b.amount || 0);
    if (aAmt !== bAmt) return aAmt - bAmt;
    return String(a.name).localeCompare(String(b.name));
  });

  return pool[0];
}

async function autoPick1GbPlanId({ ckNetwork }) {
  const rawPlans = await listDatabundlePlansV2Cached();
  const plans = pickPlansForNetwork(rawPlans, ckNetwork);
  const best = pickBest1GbPlan(plans);
  return best ? { planId: String(best.item_code), planName: String(best.name) } : null;
}

async function validateUserPin({ userId, pinInput }) {
  const freshUser = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!freshUser) {
    const err = new Error('Please login again');
    err.statusCode = 401;
    throw err;
  }

  const storedPin = String(freshUser.pin || '');
  const looksHashed = storedPin.startsWith('$2a$') || storedPin.startsWith('$2b$') || storedPin.startsWith('$2y$');
  const valid = storedPin ? (looksHashed ? await bcrypt.compare(String(pinInput), storedPin) : storedPin === String(pinInput)) : false;
  if (!valid) {
    const err = new Error('Invalid PIN');
    err.statusCode = 401;
    throw err;
  }
  return true;
}

async function weeklyCounts({ userId, weekStart, weekEnd }) {
  const baseWhere = {
    user_id: Number(userId),
    remark: 'mobile_recharge',
    trx_type: '-',
    created_at: { gte: weekStart, lt: weekEnd },
    amount: { gte: MIN_QUALIFYING_AMOUNT },
  };

  const airtimeCount = await prisma.walletTransaction.count({
    where: {
      ...baseWhere,
      meta: { path: ['type'], equals: 'airtime' },
    },
  });

  const dataCount = await prisma.walletTransaction.count({
    where: {
      ...baseWhere,
      meta: { path: ['type'], equals: 'data' },
    },
  });

  return { airtimeCount, dataCount };
}

async function me(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const now = lagosNowUtcDate();
    const weekStart = startOfWeekLagosUtc(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const week_key = isoWeekKey(now);

    const { airtimeCount, dataCount } = await weeklyCounts({ userId: user.id, weekStart, weekEnd });

    const airtime_completed = airtimeCount >= AIRTIME_TARGET;
    const data_completed = dataCount >= DATA_TARGET;

    const { start: claimStart, end: claimEnd } = claimWindowForWeek(weekStart);
    const inClaimWindow = now >= claimStart && now < claimEnd;

    const claims = await prisma.billHeroClaim.findMany({
      where: {
        user_id: Number(user.id),
        week_key,
        reward_type: { in: ['airtime', 'data'] },
        status: 'claimed',
      },
      select: { reward_type: true },
    });

    const claimedSet = new Set(claims.map((c) => String(c.reward_type || '').toLowerCase()));

    const airtime_claimed = claimedSet.has('airtime');
    const data_claimed = claimedSet.has('data');

    const airtime_claimable = airtime_completed && inClaimWindow && !airtime_claimed;
    const data_claimable = data_completed && inClaimWindow && !data_claimed;

    const claim_seconds_remaining = inClaimWindow ? Math.max(0, Math.floor((claimEnd.getTime() - now.getTime()) / 1000)) : 0;
    const week_seconds_remaining = Math.max(0, Math.floor((weekEnd.getTime() - now.getTime()) / 1000));

    const points = airtimeCount * POINTS_PER_AIRTIME + dataCount * POINTS_PER_DATA;

    return res.json({
      remark: 'bill_hero_me',
      status: 'success',
      message: ['OK'],
      data: {
        week_key,
        points,
        airtime_count: airtimeCount,
        data_count: dataCount,
        airtime_completed,
        data_completed,
        airtime_claimed,
        data_claimed,
        airtime_claimable,
        data_claimable,
        claim_seconds_remaining,
        week_seconds_remaining,
        claim_window: {
          start: claimStart.toISOString(),
          end: claimEnd.toISOString(),
        },
        rules: {
          min_amount: MIN_QUALIFYING_AMOUNT,
          airtime_target: AIRTIME_TARGET,
          data_target: DATA_TARGET,
          points_per_airtime: POINTS_PER_AIRTIME,
          points_per_data: POINTS_PER_DATA,
          airtime_reward_amount: AIRTIME_REWARD_AMOUNT,
          data_reward: '1GB',
        },
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function leaderboard(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const now = lagosNowUtcDate();
    const weekStart = startOfWeekLagosUtc(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const week_key = isoWeekKey(now);

    const baseWhere = {
      remark: 'mobile_recharge',
      trx_type: '-',
      created_at: { gte: weekStart, lt: weekEnd },
      amount: { gte: MIN_QUALIFYING_AMOUNT },
    };

    const airtimeAgg = await prisma.walletTransaction.groupBy({
      by: ['user_id'],
      where: {
        ...baseWhere,
        meta: { path: ['type'], equals: 'airtime' },
      },
      _count: { _all: true },
    });

    const dataAgg = await prisma.walletTransaction.groupBy({
      by: ['user_id'],
      where: {
        ...baseWhere,
        meta: { path: ['type'], equals: 'data' },
      },
      _count: { _all: true },
    });

    const map = new Map();

    for (const r of airtimeAgg) {
      const uid = Number(r.user_id);
      const obj = map.get(uid) || { user_id: uid, airtime_count: 0, data_count: 0, points: 0 };
      obj.airtime_count = Number(r._count?._all || 0);
      obj.points += obj.airtime_count * POINTS_PER_AIRTIME;
      map.set(uid, obj);
    }

    for (const r of dataAgg) {
      const uid = Number(r.user_id);
      const obj = map.get(uid) || { user_id: uid, airtime_count: 0, data_count: 0, points: 0 };
      obj.data_count = Number(r._count?._all || 0);
      obj.points += obj.data_count * POINTS_PER_DATA;
      map.set(uid, obj);
    }

    const rows = Array.from(map.values())
      .sort((a, b) => (b.points - a.points) || (b.airtime_count - a.airtime_count) || (b.data_count - a.data_count) || (a.user_id - b.user_id))
      .slice(0, 30);

    const ids = rows.map((r) => Number(r.user_id));
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, firstname: true, lastname: true, username: true, image: true },
    });

    const nameMap = new Map();
    const imageMap = new Map();
    for (const u of users) {
      const fn = String(u.firstname || '').trim();
      const ln = String(u.lastname || '').trim();
      const masked = fn ? `${fn} ${ln ? `${ln.substring(0, 1).toUpperCase()}.` : ''}`.trim() : (String(u.username || 'User').trim() || 'User');
      nameMap.set(Number(u.id), masked);
      imageMap.set(Number(u.id), u.image ? String(u.image) : '');
    }

    const leaderboard = rows.map((r) => ({
      user_id: r.user_id,
      name: nameMap.get(Number(r.user_id)) || 'User',
      image: imageMap.get(Number(r.user_id)) || '',
      points: r.points,
      airtime_count: r.airtime_count,
      data_count: r.data_count,
    }));

    const my = map.get(Number(user.id)) || { user_id: Number(user.id), airtime_count: 0, data_count: 0, points: 0 };
    const myRank = leaderboard.findIndex((x) => Number(x.user_id) === Number(user.id));

    return res.json({
      remark: 'bill_hero_leaderboard',
      status: 'success',
      message: ['OK'],
      data: {
        week_key,
        leaderboard,
        me: {
          user_id: Number(user.id),
          points: my.points,
          airtime_count: my.airtime_count,
          data_count: my.data_count,
          rank: myRank >= 0 ? myRank + 1 : null,
        },
      },
    });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function claim(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const reward_type = String(req.body?.reward_type || '').trim().toLowerCase();
    const phoneRaw = String(req.body?.phone || '').trim();
    const network = String(req.body?.network || '').trim().toUpperCase();
    const pin = String(req.body?.pin || '').trim();

    if (reward_type !== 'airtime' && reward_type !== 'data') {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid reward type'], data: null });
    }

    const digitsPhone = phoneRaw.replace(/\D/g, '');
    if (!digitsPhone || digitsPhone.length < 10 || digitsPhone.length > 15) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid phone number'], data: null });
    }

    if (!network) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Network is required'], data: null });
    }

    if (!pin) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['PIN is required'], data: null });
    }

    await validateUserPin({ userId: user.id, pinInput: pin });

    const now = lagosNowUtcDate();
    const weekStart = startOfWeekLagosUtc(now);
    const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const week_key = isoWeekKey(now);

    const { airtimeCount, dataCount } = await weeklyCounts({ userId: user.id, weekStart, weekEnd });

    const { start: claimStart, end: claimEnd } = claimWindowForWeek(weekStart);
    const inClaimWindow = now >= claimStart && now < claimEnd;
    if (!inClaimWindow) {
      return res.status(400).json({ remark: 'not_claim_time', status: 'error', message: ['Rewards can only be claimed on Saturday (24 hours)'], data: { claim_start: claimStart.toISOString(), claim_end: claimEnd.toISOString() } });
    }

    const completed = reward_type === 'airtime' ? airtimeCount >= AIRTIME_TARGET : dataCount >= DATA_TARGET;
    if (!completed) {
      return res.status(400).json({ remark: 'not_completed', status: 'error', message: ['Challenge not completed yet'], data: null });
    }

    const existing = await prisma.billHeroClaim.findFirst({
      where: {
        user_id: Number(user.id),
        week_key,
        reward_type,
      },
    });

    if (existing && String(existing.status || '').toLowerCase() === 'claimed') {
      return res.status(400).json({ remark: 'already_claimed', status: 'error', message: ['Reward already claimed'], data: null });
    }

    if (existing && String(existing.status || '').toLowerCase() === 'processing') {
      return res.status(400).json({ remark: 'processing', status: 'error', message: ['Claim is processing. Please try again shortly.'], data: null });
    }

    const ckNetwork = ckNetworkFromName(network);
    if (!ckNetwork) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid network'], data: null });
    }

    const ckMobile = normalizeClubKonnectMobileNumberNg(digitsPhone);
    if (!ckMobile) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid phone number'], data: null });
    }

    let claimRow = existing;
    if (!claimRow) {
      try {
        claimRow = await prisma.billHeroClaim.create({
          data: {
            user_id: Number(user.id),
            week_key,
            reward_type,
            phone: digitsPhone,
            network,
            status: 'processing',
            provider: 'clubkonnect',
          },
        });
      } catch (e) {
        if (e?.code === 'P2002') {
          claimRow = await prisma.billHeroClaim.findFirst({ where: { user_id: Number(user.id), week_key, reward_type } });
        } else {
          throw e;
        }
      }
    } else {
      claimRow = await prisma.billHeroClaim.update({
        where: { id: Number(claimRow.id) },
        data: {
          phone: digitsPhone,
          network,
          status: 'processing',
        },
      });
    }

    const requestId = `bh_${reward_type}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    try {
      let providerResp;
      if (reward_type === 'airtime') {
        providerResp = await buyAirtimeV1({
          mobileNetwork: ckNetwork,
          amount: AIRTIME_REWARD_AMOUNT,
          mobileNumber: ckMobile,
          requestId,
        });
      } else {
        const picked = await autoPick1GbPlanId({ ckNetwork });
        if (!picked || !picked.planId) {
          return res.status(502).json({
            remark: 'provider_error',
            status: 'error',
            message: ['Unable to find a 1GB data plan for the selected network. Please try again later.'],
            data: { network },
          });
        }
        providerResp = await buyDatabundleV1({
          mobileNetwork: ckNetwork,
          dataPlan: picked.planId,
          mobileNumber: ckMobile,
          requestId,
        });

        try {
          providerResp._bill_hero_selected_plan = {
            id: picked.planId,
            name: picked.planName,
          };
        } catch (_) {}
      }

      const providerRef = String(providerResp?.orderid || providerResp?.OrderID || providerResp?.order_id || providerResp?.orderID || '').trim();

      await prisma.billHeroClaim.update({
        where: { id: Number(claimRow.id) },
        data: {
          status: 'claimed',
          provider_ref: providerRef || requestId,
          provider_payload: providerResp,
          claimed_at: new Date(),
        },
      });

      return res.json({
        remark: 'bill_hero_claimed',
        status: 'success',
        message: ['Reward claimed successfully'],
        data: {
          reward_type,
          phone: digitsPhone,
          network,
          provider_ref: providerRef || requestId,
        },
      });
    } catch (err) {
      try {
        await prisma.billHeroClaim.update({
          where: { id: Number(claimRow.id) },
          data: {
            status: 'failed',
            provider_payload: err?.clubkonnect || err?.message || null,
          },
        });
      } catch (_) {}

      const status = Number(err?.statusCode) || 400;
      return res.status(status).json({
        remark: 'provider_error',
        status: 'error',
        message: [err?.message || 'Failed to claim reward'],
        data: err?.clubkonnect || null,
      });
    }
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

module.exports = {
  me,
  leaderboard,
  claim,
  history,
};
