// StaffPay's slice of the user trail. The write itself lives in
// userAudit.service, so StaffPay events and money events land in one table with
// one set of PII rules - this is only the named entry point its callers use.
const { logUserEvent } = require('./userAudit.service');

async function logStaffPayEvent({ userId, event, metadata, req = null }) {
  return logUserEvent({ req, userId, event: event || 'staffpay', metadata });
}

module.exports = {
  logStaffPayEvent,
};
