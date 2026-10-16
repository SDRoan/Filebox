const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const router = express.Router();

// Get user profile
router.get('/profile', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update user profile
router.patch('/profile', auth, async (req, res) => {
  try {
    const { name, email } = req.body;
    const user = await User.findById(req.user._id);

    if (name) user.name = name;
    if (email) {
      const existingUser = await User.findOne({ email });
      if (existingUser && existingUser._id.toString() !== user._id.toString()) {
        return res.status(400).json({ message: 'Email already in use' });
      }
      user.email = email;
    }

    await user.save();
    res.json({
      id: user._id,
      email: user.email,
      name: user.name,
      storageUsed: user.storageUsed,
      storageLimit: user.storageLimit
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Find a user by exact email (used to share and to add Team Space members).
// There is deliberately no partial search or user list, so accounts can't be enumerated.
router.get('/search', auth, async (req, res) => {
  try {
    const email = String(req.query.q || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.json([]);
    }

    const users = await User.find({ email, _id: { $ne: req.user._id } }).select('name email').limit(1);
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;










