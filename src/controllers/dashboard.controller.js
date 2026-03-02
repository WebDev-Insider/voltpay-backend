const session = require('../services/session.service');
const { getCountryByCode } = require('../helpers/country.helper');
const prisma = require('../../database/prisma');

function formatAmount(value) {
  const n = Number.parseFloat(String(value ?? 0));
  if (!Number.isFinite(n)) return '0';
  return String(Number.parseFloat(n.toFixed(2)));
}

async function getDashboard(req, res) {
  try {
    console.log('📥 Dashboard request (controller)');

    const currentUser = req.user || session.getCurrentUser();
    if (!currentUser) {
      return res.status(401).json({
        remark: 'unauthorized',
        status: 'error',
        message: ['Please login first'],
        data: null
      });
    }

    const countryDetails = getCountryByCode(currentUser.country_code);

    const fundingRows = await prisma.fundingTransaction.findMany({
      where: { user_id: Number(currentUser.id) },
      orderBy: { id: 'desc' },
      take: 5,
    });

    const recentTransactions = fundingRows.map(r => {
      const amountStr = formatAmount(r.amount);
      const status = String(r.status || '').toLowerCase();
      const statusLabel = status === 'successful' || status === 'success' ? 'Successful' : status ? status : 'Pending';

      return {
        id: r.id,
        trx: String(r.tx_ref),
        trx_type: '+',
        amount: amountStr,
        charge: '0.00',
        total_amount: amountStr,
        remark: 'fund_account',
        other_data: {
          title: 'Transfer to Wallet',
          subtitle: 'Wallet Funding',
          feedback: statusLabel,
          note: '',
          image_src: '',
        },
        details: 'Wallet funding',
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString(),
        created_at_diff: '',
      };
    });

    const response = {
      remark: 'dashboard',
      status: 'success',
      message: ['Dashboard data fetched successfully'],
      data: {
        user: {
          id: currentUser.id,
          firstname: currentUser.firstname,
          lastname: currentUser.lastname,
          username: currentUser.username,
          email: currentUser.email,
          mobile: currentUser.mobile,
          country_code: currentUser.country_code,
          country_name: countryDetails.name,
          country_flag: countryDetails.image_src,
          dial_code: countryDetails.dial_code,
          balance: currentUser.balance,
          currency_symbol: currentUser.currency_symbol || '₦',
          image: currentUser.image,
          image_url: currentUser.image_url
        },
        total_balance: currentUser.balance,
        currency: 'NGN',
        currency_symbol: currentUser.currency_symbol || '₦',
        recent_transactions: recentTransactions,
        modules: [
          { name: 'Send Money', slug: 'send_money', status: '1' },
          { name: 'Request Money', slug: 'request_money', status: '1' },
          { name: 'Cash Out', slug: 'cash_out', status: '1' },
          { name: 'Bill Payment', slug: 'bill_payment', status: '1' },
          { name: 'Fund Account', slug: 'fund_account', status: '1' }
        ]
      }
    };

    return res.json(response);
  } catch (error) {
    console.error('Error fetching dashboard (controller):', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to fetch dashboard data'],
      data: null
    });
  }
}

module.exports = { getDashboard };
