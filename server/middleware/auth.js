const jwt = require('jsonwebtoken');
const User = require('../models/User');
const appConfig = require('../config/appConfig');
const { getBypassUser } = require('../services/devAuthBypass');

const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
      const bypassUser = await getBypassUser();
      if (bypassUser) {
        req.user = bypassUser;
        req.authBypassed = true;
        return next();
      }

      return res.status(401).json({ message: 'No token, authorization denied' });
    }

    const decoded = jwt.verify(token, appConfig.jwt.secret);
    const user = await User.findById(decoded.userId).select('-password');
    
    if (!user) {
      return res.status(401).json({ message: 'Token is not valid' });
    }

    req.user = user;
    next();
  } catch (error) {
    const bypassUser = await getBypassUser();
    if (bypassUser) {
      req.user = bypassUser;
      req.authBypassed = true;
      return next();
    }

    res.status(401).json({ message: 'Token is not valid' });
  }
};

module.exports = auth;
