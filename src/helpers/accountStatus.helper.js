// User.status is the one gate every auth path checks. It now carries three
// values, and the difference matters to the client: a blocked account has to
// talk to support, a deactivated one can bring itself back on its own with the
// emailed code and its recovery phrase.
//
// Every entry point must answer identically for the same status, so nobody can
// learn more by trying a different endpoint - build the body here, never inline.
const ACTIVE = 1;
const BLOCKED = 0;
const DEACTIVATED = 2;
// Terminal. The purge worker sets it after anonymising the row: the financial
// records stay for compliance, the person is gone, and there is no way back.
const DELETED = 3;

function isActive(user) {
  return Number(user?.status) === ACTIVE;
}

function isDeactivated(user) {
  return Number(user?.status) === DEACTIVATED;
}

function isDeleted(user) {
  return Number(user?.status) === DELETED;
}

// { code, body } so callers behind a helper (resolveUserForDeviceFlow) and
// callers holding a res (login, userAuth) can both use it.
function inactiveResponse(user) {
  if (isDeactivated(user)) {
    return {
      code: 403,
      body: {
        remark: 'account_deactivated',
        status: 'error',
        message: ['This account is deactivated. Reactivate it to sign back in.'],
        data: { can_reactivate: true },
      },
    };
  }

  // A deleted account keeps no email, phone or password, so in practice the
  // lookup fails long before this. Answered here anyway for the one path that
  // holds an id already - a token issued before the purge.
  if (isDeleted(user)) {
    return {
      code: 403,
      body: {
        remark: 'account_deleted',
        status: 'error',
        message: ['This account has been permanently deleted.'],
        data: { can_reactivate: false },
      },
    };
  }

  return {
    code: 403,
    body: {
      remark: 'blocked',
      status: 'error',
      message: ['Your account is blocked. Please contact support.'],
      data: null,
    },
  };
}

// For the handlers that already hold `res`.
function sendInactive(res, user) {
  const { code, body } = inactiveResponse(user);
  return res.status(code).json(body);
}

module.exports = {
  ACTIVE,
  BLOCKED,
  DEACTIVATED,
  DELETED,
  isActive,
  isDeactivated,
  isDeleted,
  inactiveResponse,
  sendInactive,
};
