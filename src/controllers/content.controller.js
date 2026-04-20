// Static content controller for policies and FAQ

function htmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function getPolicies(req, res) {
  try {
    const appName = 'VoltPay';

    const policies = [
      {
        id: 1,
        data_keys: 'privacy_policy',
        data_values: {
          title: 'Privacy Policy',
          details: `
            <h3>Introduction</h3>
            <p>${appName} is a digital wallet that lets you send and receive money, pay bills, and manage cards. We respect your privacy and are committed to protecting your personal information.</p>
            <h3>What We Collect</h3>
            <ul>
              <li>Profile information (name, email, phone number, address, country)</li>
              <li>Usage and transaction metadata (amount, method, timestamps)</li>
            </ul>
            <h3>How We Use It</h3>
            <ul>
              <li>To provide core wallet features and customer support</li>
              <li>To comply with legal, regulatory, and anti‑fraud obligations</li>
              <li>To improve app performance, reliability, and security</li>
              <li>To send important service notifications</li>
            </ul>
            <h3>Lawful Basis</h3>
            <p>We process data on the basis of consent, contract performance, legitimate interest, and legal obligations as applicable.</p>
          `,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 2,
        data_keys: 'data_security',
        data_values: {
          title: 'Data Protection & Security',
          details: `
            <h3>Security Practices</h3>
            <ul>
              <li>Encryption in transit using HTTPS/TLS</li>
              <li>Secure credential handling and session management</li>
              <li>Role‑based access and audit logging on the server</li>
            </ul>
            <h3>Your Responsibilities</h3>
            <ul>
              <li>Keep your Password, PIN, and OTP codes confidential</li>
              <li>Log out on shared devices and keep your app updated</li>
            </ul>
          `,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 3,
        data_keys: 'cookies',
        data_values: {
          title: 'Cookies & Analytics',
          details: `
            <p>${appName} may use cookies and similar technologies (where applicable) to maintain sessions and understand app usage patterns.</p>
          `,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 4,
        data_keys: 'data_retention',
        data_values: {
          title: 'Data Retention & Deletion',
          details: `
            <p>We retain personal data only as long as necessary for service provision, legal, accounting, or reporting requirements. You may request account deletion from within the app. all your records will be deleted upon your request.</p>
          `,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 5,
        data_keys: 'contact',
        data_values: {
          title: 'Contact & Complaints',
          details: `
            <p>If you have questions about this policy or would like to exercise your data rights, please contact our Customer Service Center from within the app.</p>
          `,
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    return res.json({
      remark: 'policy_pages',
      status: 'success',
      message: ['Policies loaded successfully'],
      data: { policies },
    });
  } catch (error) {
    console.error('Error in getPolicies:', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to load policies'],
      data: null,
    });
  }
}

async function getFaq(req, res) {
  try {
    const faqs = [
      {
        id: 1,
        data_keys: 'faq',
        data_values: {
          question: 'What is VoltPay?',
          answer:
            'VoltPay is a secure digital wallet that lets you add money, send and receive funds, pay bills, buy airtime, and more.',
          icon: 'help',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 2,
        data_keys: 'faq',
        data_values: {
          question: 'How do I create an account?',
          answer:
            'Register with your mobile number, email, verify it, and complete your profile by setting a PIN, Password and basic details.',
          icon: 'person_add',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 3,
        data_keys: 'faq',
        data_values: {
          question: 'How do I add money to my wallet?',
          answer:
            'Open Add Money, the app will generate a unique bank account number for you. Use this account number to transfer funds from your bank or other payment methods. Funds will reflect in your wallet within minutes after the transfer is complete.',
          icon: 'account_balance_wallet',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 4,
        data_keys: 'faq',
        data_values: {
          question: 'What are the transfer limits and fees?',
          answer:
            'Limits and fees depend on your verification level and method.',
          icon: 'payments',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 5,
        data_keys: 'faq',
        data_values: {
          question: 'I forgot my PIN. What should I do?',
          answer:
            'Go to Profile & Settings → Security → PIN to change your PIN after confirming your current PIN.',
          icon: 'password',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 6,
        data_keys: 'faq',
        data_values: {
          question: 'How can I change my PIN?',
          answer:
            'Go to Profile & Settings → Security → PIN to change your PIN after confirming your current PIN.',
          icon: 'lock',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 7,
        data_keys: 'faq',
        data_values: {
          question:
            'A transaction failed but money was deducted. What can I do?',
          answer:
            'Most failed transactions auto‑reverse within minutes. If not, contact the Customer Service Center with the transaction reference.',
          icon: 'sync_problem',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 8,
        data_keys: 'faq',
        data_values: {
          question: 'How do I delete my account?',
          answer:
            'From Profile & Settings → Privacy Settings → Account Deletion, confirm with your Password. All your data will be permanently removed.',
          icon: 'delete',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 9,
        data_keys: 'faq',
        data_values: {
          question: 'How does VoltPay protect my data?',
          answer:
            'We use encryption, secure session management, and strict access controls. Keep your device and PIN, Password secure to protect your account.',
          icon: 'security',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: 10,
        data_keys: 'faq',
        data_values: {
          question: 'How can I contact support?',
          answer:
            'Use the Customer Service Center in the app to open a ticket. Our team will respond as soon as possible.',
          icon: 'support_agent',
        },
        tempname: 'faq',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    return res.json({
      remark: 'faq',
      status: 'success',
      message: ['FAQ loaded successfully'],
      data: { faq: faqs },
    });
  } catch (error) {
    console.error('Error in getFaq:', error);
    return res.status(500).json({
      remark: 'error',
      status: 'error',
      message: ['Failed to load FAQ'],
      data: null,
    });
  }
}

module.exports = { getPolicies, getFaq };
