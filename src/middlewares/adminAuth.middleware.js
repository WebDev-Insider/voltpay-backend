module.exports = function adminAuth(req, res, next) {
  const secret = process.env.ADMIN_API_SECRET
  if (!secret) return res.status(500).json({ remark: 'config_error', status: 'error', message: ['ADMIN_API_SECRET not configured'], data: null })
  const header = req.headers['x-admin-secret']
  if (header && header === secret) return next()
  return res.status(401).json({ remark: 'unauthorized', status: 'error', message: ['Admin access denied'], data: null })
}
