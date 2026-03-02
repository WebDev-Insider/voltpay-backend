const { setPending } = require('../services/pending.service');
const { listDatabundlePlansV2Cached } = require('../funding/clubkonnect.service');

function moneyStr(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0.00';
  return num.toFixed(2);
}

function ngDataOperators() {
  return [
    { id: 201, name: 'MTN', biller_code: 'BIL108', logo_urls: [''] },
    { id: 202, name: 'Airtel', biller_code: 'BIL110', logo_urls: [''] },
    { id: 203, name: 'Glo', biller_code: 'BIL109', logo_urls: [''] },
    { id: 204, name: '9mobile', biller_code: 'BIL111', logo_urls: [''] },
  ];
}

function ckNetworkCodeForBillerCode(billerCode) {
  const code = String(billerCode || '').trim().toUpperCase();
  if (code === 'BIL108') return '01';
  if (code === 'BIL109') return '02';
  if (code === 'BIL111') return '03';
  if (code === 'BIL110') return '04';
  return '';
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

function normalizePlan(plan, idx, billerCode) {
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
  const description = String(plan?.description ?? plan?.desc ?? plan?.Details ?? '').trim();
  const validity = String(plan?.validity ?? plan?.Validity ?? plan?.duration ?? plan?.Duration ?? '').trim();

  return {
    id,
    biller_code: billerCode,
    item_code,
    name,
    amount: Number.isFinite(amount) ? amount : 0,
    fee: 0,
    label_name: 'Mobile Number',
    description: description || validity,
  };
}

function operatorByIdOrCode(input) {
  const ops = ngDataOperators();
  const idNum = Number(input);
  return ops.find(o => Number(o.id) === idNum || String(o.biller_code).toUpperCase() === String(input).toUpperCase());
}

function countryListFor(user) {
  const balance = user?.balance?.toString ? Number(user.balance.toString()) : Number(user?.balance || 0);
  const NG = {
    id: 1,
    name: 'Nigeria',
    iso_name: 'NG',
    continent: 'Africa',
    currency_code: 'NGN',
    currency_name: 'Naira',
    currency_symbol: '₦',
    flag_url: 'ng.png',
    calling_codes: ['+234'],
    status: '1',
    operators: ngDataOperators(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  return { countries: [NG], supported_otp_types: [], current_balance: moneyStr(balance) };
}

async function create(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const data = countryListFor(user);
    return res.json({ remark: 'data_info', status: 'success', message: ['OK'], data });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function operatorsByCountry(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    const countryID = Number(req.params.countryID);
    let ops = [];
    if (countryID === 1) ops = ngDataOperators();
    const data = { operators: { data: ops }, supported_otp_types: [] };
    return res.json({ remark: 'operators', status: 'success', message: ['OK'], data });
  } catch (e) {
    return res.status(500).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: null });
  }
}

async function bundles(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });
    const billerCode = String(req.params.billerCode || '').trim().toUpperCase();
    const op = operatorByIdOrCode(billerCode);
    if (!op) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid operator/biller code'], data: null });

    const ckNetwork = ckNetworkCodeForBillerCode(op.biller_code);
    if (!ckNetwork) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid operator/biller code'], data: null });

    const rawPlans = await listDatabundlePlansV2Cached();
    const plans = pickPlansForNetwork(rawPlans, ckNetwork);
    const normalized = (Array.isArray(plans) ? plans : []).map((p, idx) => normalizePlan(p, idx, op.biller_code));
    const filtered = normalized.filter(x => x.item_code && Number(x.amount || 0) > 0);

    const data = { bundles: { data: filtered } };
    return res.json({ remark: 'bundles', status: 'success', message: ['OK'], data });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: e?.clubkonnect || null });
  }
}

async function store(req, res) {
  try {
    const user = req.user;
    if (!user) return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Please login first'], data: null });

    const operator = String(req.body?.operator || '').trim(); // id or biller_code
    const biller_code = String(req.body?.biller_code || '').trim().toUpperCase();
    const item_code = String(req.body?.item_code || '').trim();
    const country = String(req.body?.country || '1').trim(); // '1' => NG
    const calling_code = String(req.body?.calling_code || '').replace('+', '').trim();
    const mobile_number = String(req.body?.mobile_number || '').trim();
    const remark = String(req.body?.remark || 'data_bundle');

    if (!operator && !biller_code) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Operator or biller_code is required'], data: null });
    }
    if (!item_code || !calling_code || !mobile_number) {
      return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid input'], data: null });
    }

    const op = operatorByIdOrCode(biller_code || operator);
    if (!op) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid operator'], data: null });

    const ckNetwork = ckNetworkCodeForBillerCode(op.biller_code);
    if (!ckNetwork) return res.status(400).json({ remark: 'validation_error', status: 'error', message: ['Invalid operator'], data: null });

    const rawPlans = await listDatabundlePlansV2Cached();
    const plans = pickPlansForNetwork(rawPlans, ckNetwork);
    const normalized = (Array.isArray(plans) ? plans : []).map((p, idx) => normalizePlan(p, idx, op.biller_code));
    const found = normalized.find(it => String(it.item_code) === item_code);
    if (!found) return res.status(400).json({ remark: 'invalid_bundle', status: 'error', message: ['Invalid bundle'], data: null });

    const amount = Number(found.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ remark: 'invalid_amount', status: 'error', message: ['Invalid amount for bundle'], data: null });

    const payload = {
      operator_id: op.id,
      operator_name: op.name,
      biller_code: op.biller_code,
      ck_network_code: ckNetwork,
      item_code,
      item_name: found.name || 'Data Bundle',
      price: amount,
      country,
      calling_code,
      mobile_number,
    };

    setPending(user.id, remark, payload, { ttlMs: 5 * 60_000 });

    return res.json({ remark: 'pin', status: 'success', message: ['Proceed to PIN'], data: null });
  } catch (e) {
    const status = Number(e?.statusCode) || 500;
    return res.status(status).json({ remark: 'error', status: 'error', message: [e?.message || 'Failed'], data: e?.clubkonnect || null });
  }
}

module.exports = { create, operatorsByCountry, bundles, store };
