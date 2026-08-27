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
          // What this text says is what the code in account.controller.js
          // actually does, and it has to stay that way: telling a user their
          // records are all deleted on request while the law requires five
          // years of them is the misstatement the NDPA penalises.
          details: `
            <h3>Deleting your account</h3>
            <p>You can ask us to delete your account at any time from within the app. Your account closes immediately, you are signed out on every device, and any automatic payments stop.</p>
            <p>Thirty days later your login is destroyed for good: your PIN, password, recovery phrase, biometric setup, profile photo and contact details are erased, and the account can never be signed into or recovered. Changing your mind before then, by reactivating, cancels the deletion.</p>
            <h3>What we must keep, and for how long</h3>
            <p>${appName} is a payment business, so two Nigerian laws decide part of this for us. Section 19 of the Money Laundering (Prevention and Prohibition) Act 2022 and the CBN AML/CFT Regulations require us to preserve your identification details and your transaction records for <b>at least five years</b> after your account closes. For that period we hold your name, email address and phone number in encrypted form, released only to answer a regulator, a court order, or a dispute about a payment. After five years those details are erased too.</p>
            <p>Your transaction records themselves are kept permanently, as the law requires of financial records - but once the five years are up they no longer identify you.</p>
            <h3>Your rights</h3>
            <p>Under the Nigeria Data Protection Act 2023 you may ask for a copy of the data we hold about you, correct anything wrong, or ask us to delete it. Where a request conflicts with the retention duties above, we will tell you which part we cannot act on and why.</p>
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

// One place to edit the answers. The app reads them through /faq and renders
// them in order, so questions a new user asks first are listed first.
const FAQ_ENTRIES = [
  {
    question: 'What is VoltPay?',
    answer:
      'VoltPay is a secure Nigerian wallet for everyday money: fund your wallet through a dedicated account number, send and request money, buy airtime and data, pay electricity, cable TV and school fees, and run staff salaries with StaffPay.',
    icon: 'help',
  },
  {
    question: 'How do I create an account?',
    answer:
      'Register with your Nigerian phone number and email, verify both, then set a transaction PIN and a password. Complete your profile and KYC to lift your limits.',
    icon: 'person_add',
  },
  {
    question: 'How do I add money to my wallet?',
    answer:
      'Open Fund Account. VoltPay creates one dedicated bank account number that belongs to you permanently. Transfer to it from any Nigerian bank and your wallet is credited automatically, usually within minutes. You never need a card.',
    icon: 'account_balance_wallet',
  },
  {
    question: 'Why does my account number never change?',
    answer:
      'Your dedicated account is static, so you can save it as a beneficiary in your bank app and reuse it forever. Any transfer to it lands in your VoltPay wallet.',
    icon: 'account_balance',
  },
  {
    question: 'How do I send money to another VoltPay user?',
    answer:
      'Open Send Money, enter their username or phone number, confirm the name that comes back, enter the amount and approve with your PIN or biometrics. Transfers between VoltPay wallets are instant.',
    icon: 'send',
  },
  {
    question: 'How does Request Money work?',
    answer:
      'Open Request Money, pick the person from your contacts or enter their username, set the amount and add a note. They get a notification and pay it with their own PIN - nothing leaves your wallet, and nothing leaves theirs until they approve. Requests expire if they are not paid.',
    icon: 'request_quote',
  },
  {
    question: 'Which bills can I pay?',
    answer:
      'Airtime and data on all Nigerian networks, electricity (prepaid and postpaid tokens), cable TV subscriptions, school fees, betting wallets and donations. Meter and smartcard numbers are verified with the provider before you are charged.',
    icon: 'receipt_long',
  },
  {
    question: 'What is Bill Hero?',
    answer:
      'Bill Hero rewards you for paying bills through VoltPay. Every qualifying payment earns points and moves you up the leaderboard - check the Bill Hero screen for your current streak and rewards.',
    icon: 'emoji_events',
  },
  {
    question: 'What is StaffPay?',
    answer:
      'StaffPay pays your staff automatically. Register your business, pass verification, add each staff member with their role, bank account and monthly salary, and choose a payday between the 25th and the 29th. On that day VoltPay pays everyone at once, in Nigerian time.',
    icon: 'groups',
  },
  {
    question: 'How do I fund StaffPay?',
    answer:
      'Your business gets its own dedicated StaffPay account number - open StaffPay and tap View Virtual Account. Transfer into it and the StaffPay wallet is credited automatically. Fund it before payday: nothing is paid until the wallet covers every salary in full.',
    icon: 'business_center',
  },
  {
    question: 'A staff salary failed. What happens?',
    answer:
      'Only the failed transfers fail - everyone else is still paid. Open StaffPay, go to Transfers, and use Retry failed. Your wallet is debited again only for the transfers being retried.',
    icon: 'replay',
  },
  {
    question: 'What are the transfer limits and fees?',
    answer:
      'Limits depend on your KYC level and fees depend on the service. The exact charge is always shown on the confirmation screen before you approve, so you never pay a fee you have not seen.',
    icon: 'payments',
  },
  {
    question: 'I forgot my PIN. What should I do?',
    answer:
      'On the PIN screen tap Forgot PIN and confirm with your password or your recovery phrase. If you know your current PIN and only want to change it, use Profile & Settings → Security → PIN.',
    icon: 'password',
  },
  {
    question: 'What is the recovery phrase for?',
    answer:
      'The recovery phrase is shown once when you set up your account. It is the only way back in if you lose your phone, your password and your PIN. Write it down and keep it offline - anyone who has it can reach your account, and VoltPay staff will never ask you for it.',
    icon: 'key',
  },
  {
    question: 'Can I log in with Face ID or my fingerprint?',
    answer:
      'Yes. Turn biometrics on in Profile & Settings → Security. Your PIN still works as a fallback, and large or sensitive actions ask for it again.',
    icon: 'fingerprint',
  },
  {
    question: 'Why can I not edit my first and last name?',
    answer:
      'Your legal name is tied to your KYC record and to the reports VoltPay files, so it is fixed after registration. If it is wrong, open a support ticket and we will correct it.',
    icon: 'badge',
  },
  {
    question: 'A transaction failed but money was deducted. What can I do?',
    answer:
      'Most failed transactions reverse automatically within minutes. If it has not reversed, open a support ticket from the transaction itself - the receipt and reference are attached for you.',
    icon: 'sync_problem',
  },
  {
    question: 'Why is the app asking me to update?',
    answer:
      'A forced update means the version you have can no longer talk to our payment partners safely. Install the new version from your store to keep transacting.',
    icon: 'system_update',
  },
  {
    question: 'How does VoltPay protect my data?',
    answer:
      'Your PIN, password and recovery phrase are hashed and can never be read back, and personal details are encrypted at rest. Every session is device-bound and new-device logins are challenged. Keep your device lock, PIN and password to yourself.',
    icon: 'security',
  },
  {
    question: 'How do I delete my account?',
    answer:
      'Profile & Settings → Privacy Settings → Account Deletion, confirmed with your password. Withdraw your balance first - deletion is permanent.',
    icon: 'delete',
  },
  {
    question: 'How can I contact support?',
    answer:
      'Open the Customer Service Center in the app and create a ticket. Add a screenshot and the transaction reference and we can resolve it far faster.',
    icon: 'support_agent',
  },
];

async function getFaq(req, res) {
  try {
    const now = new Date().toISOString();
    const faqs = FAQ_ENTRIES.map((entry, index) => ({
      id: index + 1,
      data_keys: 'faq',
      data_values: entry,
      tempname: 'faq',
      created_at: now,
      updated_at: now,
    }));

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
