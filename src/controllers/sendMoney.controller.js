const prisma = require('../../database/prisma');
const { Prisma } = require('@prisma/client');
const { getCountryByCode } = require('../helpers/country.helper');
const { setPending } = require('../services/pending.service');
const { generateTrx } = require('../services/airtime.service');

function moneyStr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

function parseUserInputToLookup(userInputRaw) {
  const raw = String(userInputRaw || '').trim();
  if (!raw) return { username: '', mobile: '' };
  const digits = raw.replace(/\D/g, '');
  const isNumeric = digits.length > 0 && digits.length >= Math.min(raw.length, digits.length);
  if (isNumeric) {
    const last10 = digits.length > 10 ? digits.slice(-10) : digits;
    // Return a comma-delimited list we can fan-out into OR conditions.
    // DB may store either 10-digit (8012345678) or 11-digit with leading 0 (08012345678).
    const variants = Array.from(
      new Set([
        digits,
        last10,
        last10.length === 10 ? `0${last10}` : '',
      ].filter(Boolean))
    );
    return { username: '', mobile: variants.join(',') };
  }
  return { username: raw, mobile: '' };
}

function chargeConfig() {
  return {
    id: 1,
    name: 'Send Money',
    slug: 'send_money',
    fixed_charge: '10',
    percent_charge: '0',
    min_limit: '50',
    max_limit: '1000000',
    cap: '-1',
  };
}

async function info(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const fresh = await prisma.user.findUnique({ where: { id: Number(user.id) } });
    const balance = Number(fresh?.balance?.toString?.() ?? fresh?.balance ?? 0);

    const data = {
      supported_otp_types: [],
      current_balance: moneyStr(balance),
      send_money_charge: chargeConfig(),
      latest_send_money: [],
    };

    return res.json({ remark: 'send_money', status: 'success', message: ['OK'], data });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function store(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const amount = Number(req.body?.amount);
    const userInput = String(req.body?.user || '').trim();
    const remark = String(req.body?.remark || 'send_money').trim();

    if (!userInput || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid input'], data: null });
    }

    const lookup = parseUserInputToLookup(userInput);
    const mobileVariants = lookup.mobile
      ? lookup.mobile.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    const receiver = await prisma.user.findFirst({
      where: {
        OR: [
          ...(lookup.username ? [{ username: lookup.username }] : []),
          ...(mobileVariants.length ? mobileVariants.map(m => ({ mobile: m })) : []),
        ],
      },
    });

    if (!receiver) {
      return res.status(404).json({ remark: 'not_found', status: 'error', message: ['User not found'], data: null });
    }

    if (Number(receiver.id) === Number(user.id)) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['You cannot send money to yourself'], data: null });
    }

    if (Number(receiver.status) !== 1) {
      return res.status(403).json({ remark: 'blocked', status: 'error', message: ['Recipient account is blocked'], data: null });
    }

    const cfg = chargeConfig();
    const fixed = Number(cfg.fixed_charge || 0) || 0;
    const percent = Number(cfg.percent_charge || 0) || 0;
    const rawCharge = (amount * percent) / 100 + fixed;
    const cap = Number(cfg.cap || -1);
    const charge = cap !== -1 && rawCharge > cap ? cap : rawCharge;
    const total = amount + (Number.isFinite(charge) ? charge : 0);

    const payload = {
      amount,
      charge,
      total_amount: total,
      receiver_id: Number(receiver.id),
      receiver_username: receiver.username,
      receiver_firstname: receiver.firstname,
      receiver_lastname: receiver.lastname,
      receiver_email: receiver.email,
      receiver_mobile: receiver.mobile,
      receiver_country_code: receiver.country_code,
      receiver_image: receiver.image,
      transfer_ref: generateTrx('sm'),
    };

    setPending(user.id, remark, payload, { ttlMs: 5 * 60_000 });

    return res.json({ remark: 'pin', status: 'success', message: ['Proceed to PIN'], data: null });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function history(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const page = Math.max(1, Number(req.query?.page || 1) || 1);
    const pageSize = 15;
    const skip = (page - 1) * pageSize;

    let rows = [];
    try {
      rows = await prisma.walletTransaction.findMany({
        where: { user_id: Number(user.id), remark: 'send_money' },
        orderBy: { id: 'desc' },
        skip,
        take: pageSize + 1,
      });
    } catch (_) {
      rows = [];
    }

    const hasNext = rows.length > pageSize;
    if (hasNext) rows = rows.slice(0, pageSize);

    const receiverIds = Array.from(
      new Set(
        rows
          .map(r => Number(r?.meta?.receiver_id))
          .filter(v => Number.isFinite(v) && v > 0)
      )
    );

    const receiverUsers = receiverIds.length
      ? await prisma.user.findMany({ where: { id: { in: receiverIds } } })
      : [];
    const receiverMap = new Map(receiverUsers.map(u => [Number(u.id), u]));

    const dataList = rows.map(r => {
      const meta = r.meta || {};
      const receiverId = Number(meta.receiver_id) || null;
      const receiver = receiverId ? receiverMap.get(receiverId) : null;
      const countryDetails = receiver ? getCountryByCode(receiver.country_code) : null;

      return {
        id: r.id,
        sender_id: Number(user.id),
        receiver_id: receiverId,
        amount: moneyStr(r.amount),
        charge: moneyStr(r.charge),
        total_amount: moneyStr(r.total_amount),
        sender_post_balance: null,
        receiver_post_balance: null,
        trx: String(r.trx),
        sender_details: r.details || '',
        receiver_details: '',
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
        updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : new Date(r.updated_at).toISOString(),
        receiver_user: receiver
          ? {
              id: receiver.id,
              firstname: receiver.firstname,
              lastname: receiver.lastname,
              username: receiver.username,
              email: receiver.email,
              mobile: receiver.mobile,
              dial_code: countryDetails?.dial_code,
              country_code: receiver.country_code,
              country_name: countryDetails?.name,
              country_flag: countryDetails?.image_src,
              image: receiver.image,
              image_src: receiver.image,
            }
          : null,
      };
    });

    const nextPageUrl = hasNext ? `${req.baseUrl}${req.path}?page=${page + 1}` : null;

    return res.json({
      remark: 'send_money_history',
      status: 'success',
      message: ['OK'],
      data: {
        send_moneys: {
          data: dataList,
          next_page_url: nextPageUrl,
          path: `${req.baseUrl}${req.path}`,
        },
      },
    });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

module.exports = { info, store, history };
