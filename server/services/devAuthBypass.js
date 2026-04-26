const User = require('../models/User');
const Folder = require('../models/Folder');

const isDevAuthBypassEnabled = () => {
  if (process.env.AUTH_BYPASS_ENABLED === 'true') {
    return true;
  }

  if (process.env.AUTH_BYPASS_ENABLED === 'false') {
    return false;
  }

  return process.env.NODE_ENV !== 'production';
};

const ensureRootFolder = async (userId) => {
  const existingRoot = await Folder.findOne({
    owner: userId,
    parentFolder: null,
  });

  if (!existingRoot) {
    await Folder.create({
      name: 'My Files',
      owner: userId,
      parentFolder: null,
    });
  }
};

const getBypassUser = async () => {
  if (!isDevAuthBypassEnabled()) {
    return null;
  }

  const preferredEmail = process.env.AUTH_BYPASS_EMAIL?.toLowerCase().trim();

  let user = null;

  if (preferredEmail) {
    user = await User.findOne({ email: preferredEmail }).select('-password');
  }

  if (!user) {
    user = await User.findOne()
      .sort({ lastLogin: -1, createdAt: -1 })
      .select('-password');
  }

  if (!user) {
    const createdUser = await User.create({
      email: preferredEmail || 'workspace@local.filebox',
      password: process.env.AUTH_BYPASS_PASSWORD || 'local-dev-password',
      name: process.env.AUTH_BYPASS_NAME || 'Local Workspace',
    });

    user = await User.findById(createdUser._id).select('-password');
  }

  await ensureRootFolder(user._id);
  return user;
};

module.exports = {
  getBypassUser,
  isDevAuthBypassEnabled,
};
