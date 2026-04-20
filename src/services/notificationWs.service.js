const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const prisma = require('../../database/prisma');

let _wss = null;

const _clientsByUserId = new Map();

function _addClient(userId, ws) {
  const id = Number(userId);
  if (!id || Number.isNaN(id)) return;
  let set = _clientsByUserId.get(id);
  if (!set) {
    set = new Set();
    _clientsByUserId.set(id, set);
  }
  set.add(ws);
}

function _removeClient(userId, ws) {
  const id = Number(userId);
  if (!id || Number.isNaN(id)) return;
  const set = _clientsByUserId.get(id);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    _clientsByUserId.delete(id);
  }
}

function _safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return null;
  }
}

function broadcastToUserIds(userIds, payload) {
  if (!userIds || !Array.isArray(userIds) || userIds.length === 0) return;
  const msg = _safeJsonStringify(payload);
  if (!msg) return;

  for (const rawId of userIds) {
    const id = Number(rawId);
    if (!id || Number.isNaN(id)) continue;
    const clients = _clientsByUserId.get(id);
    if (!clients || clients.size === 0) continue;

    for (const ws of clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      } catch (_) {}
    }
  }
}

function broadcastToAll(payload) {
  const msg = _safeJsonStringify(payload);
  if (!msg) return;

  for (const [, clients] of _clientsByUserId.entries()) {
    for (const ws of clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(msg);
        }
      } catch (_) {}
    }
  }
}

function _parseWsQuery(req) {
  try {
    const u = new URL(req.url, 'http://localhost');
    const token = (u.searchParams.get('token') || '').trim();
    const deviceId = (u.searchParams.get('device_id') || u.searchParams.get('deviceId') || '').trim();
    return { token, deviceId };
  } catch (_) {
    return { token: '', deviceId: '' };
  }
}

async function _authenticate(req) {
  const { token, deviceId } = _parseWsQuery(req);
  if (!token) return { ok: false, reason: 'missing_token' };

  const secret = process.env.JWT_SECRET;
  if (!secret) return { ok: false, reason: 'jwt_secret_missing' };

  let payload;
  try {
    payload = jwt.verify(String(token), secret);
  } catch (_) {
    return { ok: false, reason: 'invalid_token' };
  }

  const userId = payload && payload.sub ? Number(payload.sub) : null;
  if (!userId || Number.isNaN(userId)) return { ok: false, reason: 'invalid_user' };

  const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
  if (!user) return { ok: false, reason: 'user_not_found' };

  const tokenSid = payload && payload.sid ? String(payload.sid) : '';
  const activeSid = user.active_session_id ? String(user.active_session_id) : '';
  if (!tokenSid || !activeSid || tokenSid !== activeSid) {
    return { ok: false, reason: 'session_revoked' };
  }

  const activeDeviceId = user.active_device_id ? String(user.active_device_id) : '';
  if (activeDeviceId && String(deviceId || '').trim() !== activeDeviceId) {
    return { ok: false, reason: 'device_mismatch' };
  }

  if (Number(user.status) !== 1) {
    return { ok: false, reason: 'blocked' };
  }

  return { ok: true, userId: Number(user.id) };
}

function initNotificationWs(server) {
  if (_wss) return _wss;

  _wss = new WebSocket.Server({ server, path: '/ws/notifications' });

  _wss.on('connection', (ws, req) => {
    (async () => {
      let auth;
      try {
        auth = await _authenticate(req);
      } catch (_) {
        auth = { ok: false, reason: 'auth_error' };
      }

      if (!auth.ok) {
        try {
          ws.close(1008, auth.reason || 'unauthorized');
        } catch (_) {}
        return;
      }

      const userId = auth.userId;
      ws.__userId = userId;
      _addClient(userId, ws);

      try {
        ws.send(JSON.stringify({ event: 'ws.ready' }));
      } catch (_) {}

      ws.on('close', () => {
        _removeClient(userId, ws);
      });

      ws.on('error', () => {
        _removeClient(userId, ws);
      });
    })();
  });

  return _wss;
}

module.exports = {
  initNotificationWs,
  broadcastToUserIds,
  broadcastToAll,
};
