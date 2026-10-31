const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
require('dotenv').config();
const appConfig = require('./config/appConfig');
const { optionalRoute } = require('./utils/optionalModule');


const authRoutes = require('./routes/auth');
const fileRoutes = require('./routes/files');
const shareRoutes = require('./routes/share');
const userRoutes = require('./routes/users');
const boardRoutes = require('./routes/boards');
const companionRoutes = require('./routes/companion');
const commentRoutes = require('./routes/comments');
const teamFolderRoutes = require('./routes/teamFolders');
const fileRequestRoutes = require('./routes/fileRequests');
const searchRoutes = require('./routes/search');
const debugRoutes = require('./routes/debug');
const relationshipRoutes = require('./routes/relationships');
const smartOrganizationRoutes = require('./routes/smartOrganization');
const analyticsRoutes = require('./routes/analytics');

// Student-product surfaces (courses, assignments, study tools, forums, learning library)
// are not part of File Box. Their code stays in the repo, but routes are off by default.
const STUDENT_FEATURES_ENABLED = process.env.FILEBOX_ENABLE_STUDENT_FEATURES === 'true';

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: appConfig.server.clientUrl,
    methods: ["GET", "POST"]
  }
});

// Middleware - CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : [appConfig.server.clientUrl || 'http://localhost:3000'];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
// Settings > Customize > Background: an uploaded picture is larger than other requests.
app.use('/api/users/preferences/background', express.json({ limit: '4mb' }));
// Ask File Box screen awareness: a question may carry one screenshot of the visible File Box screen.
app.use('/api/ai-assistant/chat', express.json({ limit: '6mb' }));
// Boards: a text area can hold up to 100 KB and a tab up to 1 MB (checked by the Boards service itself).
app.use('/api/workspace-boards', express.json({ limit: '1536kb' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create uploads directory if it doesn't exist
const fs = require('fs-extra');
const uploadsDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadsDir);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/users', userRoutes);
app.use('/api/boards', boardRoutes);
// Boards page: a person's own tabbed workspace (references to files and folders, plus notes).
app.use('/api/workspace-boards', require('./routes/workspaceBoards'));
app.use('/api/companion', companionRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/team-folders', teamFolderRoutes);
app.use('/api/file-requests', fileRequestRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/relationships', relationshipRoutes);
app.use('/api/smart-org', smartOrganizationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/security', require('./routes/security'));
app.use('/api/annotations', require('./routes/annotations'));
app.use('/api/collections', require('./routes/collections'));
app.use('/api/summaries', require('./routes/summaries'));
app.use('/api/signatures', require('./routes/signatures'));
app.use('/api/ai-assistant', require('./routes/aiAssistant'));
app.use('/api/home', require('./routes/home'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/file-memory', require('./routes/fileMemory'));
app.use('/api/predictive-org', optionalRoute(path.join(__dirname, 'routes/predictiveOrganization.js'), [path.join(__dirname, 'services/predictiveOrganization.js')]));
app.use('/api/cloud-backup', require('./routes/cloudBackup'));
app.use('/api/templates', optionalRoute(path.join(__dirname, 'routes/templates.js'), [path.join(__dirname, 'models/Template.js')]));
app.use('/api/web-shortcuts', optionalRoute(path.join(__dirname, 'routes/webShortcuts.js'), [path.join(__dirname, 'models/WebShortcut.js')]));
app.use('/api/secured-links', require('./routes/securedLinks'));
app.use('/api/integrations', require('./routes/integrations'));

if (STUDENT_FEATURES_ENABLED) {
  app.use('/api/groups', require('./routes/groups'));
  app.use('/api/assignments', require('./routes/assignments'));
  app.use('/api/courses', require('./routes/courses'));
  app.use('/api/study-groups', require('./routes/studyGroups'));
  app.use('/api/calendar', require('./routes/calendar'));
  app.use('/api/referrals', require('./routes/referrals'));
  app.use('/api/forums', require('./routes/forums'));
  app.use('/api/learning', require('./routes/learning'));
  app.use('/api/course-notes', require('./routes/courseNotes'));
  app.use('/api/study-schedule', require('./routes/studySchedule'));
  app.use('/api/progress-tracking', require('./routes/progressTracking'));
  app.use('/api/study-sessions', require('./routes/studySessions'));
}

// Socket.io for real-time updates
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-user-room', (userId) => {
    socket.join(`user-${userId}`);
  });

  socket.on('join-team-folder', (teamFolderId) => {
    socket.join(`team-folder-${teamFolderId}`);
    console.log(`User ${socket.id} joined team folder ${teamFolderId}`);
  });

  socket.on('leave-team-folder', (teamFolderId) => {
    socket.leave(`team-folder-${teamFolderId}`);
    console.log(`User ${socket.id} left team folder ${teamFolderId}`);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Make io available to routes
app.set('io', io);

// Database connection
mongoose.connect(appConfig.database.uri)
.then(() => {
  console.log('MongoDB connected');
  // Advanced Search categories for files read before they existed: rules and stored profiles only, no AI.
  require('./services/fileClassifier').catchUp().catch(error => console.error('[Classify] Catch-up failed:', error.message));
})
.catch(err => console.error('MongoDB connection error:', err));

// Cleanup job: permanently delete Trash items after the recovery period (30 days)
const cleanupTrash = async () => {
  try {
    const { purgeTrash, RECOVERY_DAYS } = require('./services/trash');
    const { files, folders } = await purgeTrash({ olderThanDays: RECOVERY_DAYS });
    if (files || folders) {
      console.log(`[Cleanup] Permanently deleted ${files} files and ${folders} folders after the ${RECOVERY_DAYS}-day recovery period`);
    }
  } catch (error) {
    console.error('[Cleanup] Error in trash cleanup job:', error);
  }
};

// Run cleanup job every 24 hours
setInterval(cleanupTrash, 24 * 60 * 60 * 1000); // 24 hours in milliseconds
// Also run immediately on server start
setTimeout(cleanupTrash, 60000); // Run after 1 minute of server startup

// Folder Sync scheduler (services/cloudBackup.js): runs syncs that are due, each for its own account.
const runCloudBackups = async () => {
  try {
    const CloudBackup = require('./models/CloudBackup');
    const cloudBackupService = require('./services/cloudBackup');
    if (!cloudBackupService.isEnabled()) return;
    const due = await CloudBackup.find({
      enabled: true,
      status: { $ne: 'backing_up' },
      $or: [{ nextBackupAt: { $lte: new Date() } }, { nextBackupAt: null }],
    });
    for (const backup of due) {
      try {
        await cloudBackupService.performBackup(backup._id, backup.user);
      } catch (error) {
        console.error(`[Folder Sync] ${backup.sourcePath}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[Folder Sync] Scheduler error:', error);
  }
};

setInterval(runCloudBackups, 60 * 60 * 1000); // every hour
setTimeout(runCloudBackups, 120000); // and 2 minutes after start
// Syncs that were running when the server stopped did not finish.
require('./services/cloudBackup').resetInterrupted().catch(() => {});

const PORT = appConfig.server.port;
const CLIENT_URL = appConfig.server.clientUrl;
const CLIENT_PORT = CLIENT_URL.includes(':') 
  ? CLIENT_URL.split(':').pop().replace('/', '') 
  : '3000';

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n' + '═'.repeat(70));
  console.log('🚀  SERVER STARTED SUCCESSFULLY!');
  console.log('═'.repeat(70));
  console.log(`📡 Backend API:  http://localhost:${PORT}`);
  console.log(`🌐 Frontend App: http://localhost:${CLIENT_PORT}`);
  console.log('═'.repeat(70));
  
  // File Box AI notes what each file is in the background (local Ollama only, skipped when it is off).
  require('./services/fileProfiler').start();

  // The learning library is a student feature; only refresh it when those features are enabled.
  if (STUDENT_FEATURES_ENABLED) {
    try {
      require('./services/learningResourceScheduler').start();
    } catch (error) {
      console.error('Failed to start learning resource scheduler:', error);
    }
  }
  console.log(`\n✨  👉  OPEN YOUR BROWSER: http://localhost:${CLIENT_PORT}  👈  ✨\n`);
  console.log('═'.repeat(70) + '\n');
  
  // Browser navigation is manual; server restarts must not open tabs.
});
