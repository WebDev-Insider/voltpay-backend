/**
 * What a wallet_transactions row was spent on.
 *
 * Lives here rather than in either caller because two of them need the same
 * answer - the monthly statement and the spending-insight push - and a split
 * that disagrees between them means the statement and the notification quote
 * different numbers for the same week.
 *
 * The airtime/data distinction is the fiddly one: both are written with
 * `remark: 'mobile_recharge'` (bills.controller SERVICES), so the kind is only
 * in `meta`. `meta.service` is stamped when the debit row is created;
 * `meta.type` is stamped later, in the update that follows the provider
 * accepting. Reading `type` alone files every still-processing data bundle as
 * airtime.
 */

const LABEL = {
  airtime: 'airtime',
  data: 'data',
  electricity: 'electricity',
  tv: 'TV subscription',
  betting: 'betting',
  transfer: 'transfers',
  other: 'other payments',
};

// The categories worth nudging someone about. Transfers are spend, but "you
// sent the most money to people" is not an overspending insight.
const BILL_CATEGORIES = ['data', 'airtime', 'electricity', 'tv', 'betting'];

function categorize(row) {
  const remark = String(row?.remark || '').toLowerCase();

  if (remark === 'utility_bill') return 'electricity';
  if (remark === 'cable_tv') return 'tv';
  if (remark === 'betting') return 'betting';
  if (remark === 'send_money' || remark === 'request_money') return 'transfer';

  if (remark === 'mobile_recharge') {
    const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
    const kind = String(meta.service || meta.type || '').toLowerCase();
    return kind === 'data' ? 'data' : 'airtime';
  }

  return 'other';
}

/** True for the credit leg of a refund, which cancels a debit of the same kind. */
function isReversal(row) {
  const meta = row?.meta && typeof row.meta === 'object' ? row.meta : {};
  return Boolean(meta.reversal_of);
}

module.exports = { categorize, isReversal, LABEL, BILL_CATEGORIES };
