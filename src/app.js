'use strict';
const path = require('path');
const express = require('express');
const { loadUser, HttpError } = require('./auth');

function createApp(db, opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', 1);

  // Header bảo mật cơ bản
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'"
    );
    next();
  });

  app.use(express.json({ limit: '200kb' }));

  // Chống CSRF: mọi request thay đổi dữ liệu phải gửi JSON (form từ trang khác không gửi được)
  app.use('/api', (req, _res, next) => {
    // (DELETE/PUT không gửi được từ form HTML trang khác; POST thì bắt buộc JSON)
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json'))
      return next(new HttpError(415, 'Yêu cầu phải ở dạng JSON.'));
    next();
  });

  app.use(loadUser(db));
  app.use('/api/auth', require('./routes/auth')(db, opts));
  app.use('/api/admin', require('./routes/admin')(db));
  app.use('/api', require('./routes/reports')(db));
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Không tìm thấy API.')));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  // Xử lý lỗi chung
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Dữ liệu gửi lên không hợp lệ.');
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Lỗi máy chủ, vui lòng thử lại.' : err.message, details: err.details });
  });

  return app;
}

module.exports = { createApp };
