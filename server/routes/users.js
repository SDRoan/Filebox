const express = require('express');
const auth = require('../middleware/auth');
const User = require('../models/User');
const { sanitizeAppearance, isBackgroundImage } = require('../utils/appearance');
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

// Appearance preferences (Settings > Appearance and Settings > Customize)
router.get('/preferences', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('accentColor appearance').lean();
    res.json({ accentColor: user?.accentColor || null, appearance: user?.appearance || null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Either setting can be sent alone; whatever is left out stays as it was.
router.put('/preferences', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    if ('accentColor' in body) {
      const value = body.accentColor;
      if (value !== null && !(typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value))) {
        return res.status(400).json({ message: 'Choose a color like #3f6543.' });
      }
      update.accentColor = value ? value.toLowerCase() : null;
    }
    if ('appearance' in body) {
      if (body.appearance !== null && (typeof body.appearance !== 'object' || Array.isArray(body.appearance))) {
        return res.status(400).json({ message: 'That look could not be read.' });
      }
      update.appearance = sanitizeAppearance(body.appearance);
    }
    if (!Object.keys(update).length) return res.status(400).json({ message: 'Nothing to save.' });
    await User.updateOne({ _id: req.user._id }, { $set: update });
    res.json(update);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Settings > Customize > Background: the uploaded picture, kept apart so other changes stay small.
router.get('/preferences/background', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+backgroundImage').lean();
    res.json({ image: user?.backgroundImage || null });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.put('/preferences/background', auth, async (req, res) => {
  try {
    const image = req.body?.image ?? null;
    if (image !== null && !isBackgroundImage(image)) {
      return res.status(400).json({ message: 'Choose a JPEG, PNG or WebP picture under 3 MB.' });
    }
    await User.updateOne({ _id: req.user._id }, { $set: { backgroundImage: image } });
    res.json({ saved: true });
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










