const express = require('express');
const router = express.Router();
const { getFileRole, authorizeFile, sendDenied } = require('../services/permissions');
const { pageInfo, pageImage, stampSignature } = require('../services/pdfSign');
const { snapshotCurrentVersion, replaceFileContents, newLivePath } = require('../services/fileVersions');
const Activity = require('../models/Activity');
const auth = require('../middleware/auth');
const Signature = require('../models/Signature');
const DocumentSignature = require('../models/DocumentSignature');
const File = require('../models/File');
const fs = require('fs-extra');

// Get all user signatures
router.get('/', auth, async (req, res) => {
  try {
    const signatures = await Signature.find({ user: req.user._id })
      .sort({ isDefault: -1, createdAt: -1 });
    res.json(signatures);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get a specific signature
router.get('/:signatureId', auth, async (req, res) => {
  try {
    const signature = await Signature.findById(req.params.signatureId);
    
    if (!signature) {
      return res.status(404).json({ message: 'Signature not found' });
    }
    
    if (signature.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    res.json(signature);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Create a new signature
router.post('/', auth, async (req, res) => {
  try {
    const { name, signatureData, isDefault } = req.body;
    
    if (!name || !signatureData) {
      return res.status(400).json({ message: 'Name and signature data are required' });
    }
    
    // Validate base64 image data
    if (!signatureData.startsWith('data:image/')) {
      return res.status(400).json({ message: 'Invalid signature format. Must be base64 image data.' });
    }
    
    // If this is set as default, unset other defaults
    if (isDefault) {
      await Signature.updateMany(
        { user: req.user._id },
        { isDefault: false }
      );
    }
    
    const signature = new Signature({
      user: req.user._id,
      name: name.trim(),
      signatureData,
      isDefault: isDefault || false
    });
    
    await signature.save();
    res.status(201).json(signature);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Update signature
router.put('/:signatureId', auth, async (req, res) => {
  try {
    const { name, isDefault } = req.body;
    const signature = await Signature.findById(req.params.signatureId);
    
    if (!signature) {
      return res.status(404).json({ message: 'Signature not found' });
    }
    
    if (signature.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    if (name) {
      signature.name = name.trim();
    }
    
    if (isDefault !== undefined) {
      signature.isDefault = isDefault;
      // If setting as default, unset other defaults
      if (isDefault) {
        await Signature.updateMany(
          { user: req.user._id, _id: { $ne: signature._id } },
          { isDefault: false }
        );
      }
    }
    
    await signature.save();
    res.json(signature);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Delete signature
router.delete('/:signatureId', auth, async (req, res) => {
  try {
    const signature = await Signature.findById(req.params.signatureId);
    
    if (!signature) {
      return res.status(404).json({ message: 'Signature not found' });
    }
    
    if (signature.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    // Check if signature is used in any documents
    const documentSignatures = await DocumentSignature.find({ signature: signature._id });
    if (documentSignatures.length > 0) {
      return res.status(400).json({ 
        message: 'Cannot delete signature that is used in documents',
        usedInDocuments: documentSignatures.length
      });
    }
    
    await signature.deleteOne();
    res.json({ message: 'Signature deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Apply signature to a document
// Pages of a PDF, for placing a signature: count and sizes, then each page as an image.
router.get('/document/:fileId/pages', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.fileId, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    if (!/pdf/i.test(access.file.mimeType)) return res.status(400).json({ message: 'Only PDF files can be signed.' });
    res.json(await pageInfo(access.file.path));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || 'Could not read this PDF.' });
  }
});

router.get('/document/:fileId/pages/:page', auth, async (req, res) => {
  try {
    const access = await authorizeFile(req.params.fileId, req.user._id, 'viewer');
    if (sendDenied(res, access)) return;
    const page = parseInt(req.params.page, 10);
    if (!/pdf/i.test(access.file.mimeType) || !(page >= 1)) return res.status(400).json({ message: 'Choose a page of a PDF.' });
    res.set('Content-Type', 'image/png').set('Cache-Control', 'private, max-age=60').send(await pageImage(access.file.path, page));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || 'Could not show this page.' });
  }
});

/**
 * Sign a PDF with one of your saved signatures. Only the owner or an editor may sign. The unsigned file
 * is kept as a version first, so signing can always be undone from Version history.
 * Body: { signatureId, pageNumber, position: { x, y, width } } (fractions of the page, from the top-left).
 */
router.post('/apply/:fileId', auth, async (req, res) => {
  try {
    const { signatureId, pageNumber, position } = req.body || {};
    const fraction = (value) => typeof value === 'number' && value >= 0 && value <= 1;
    if (!signatureId || !(pageNumber >= 1) || !position || !fraction(position.x) || !fraction(position.y) || !(position.width > 0.02 && position.width <= 1)) {
      return res.status(400).json({ message: 'Choose a signature and where to put it.' });
    }

    const access = await authorizeFile(req.params.fileId, req.user._id, 'editor');
    if (sendDenied(res, access)) return;
    const { file } = access;
    if (file.isTrashed) return res.status(404).json({ message: 'File not found' });
    if (!/pdf/i.test(file.mimeType)) return res.status(400).json({ message: 'Only PDF files can be signed.' });
    if (!(await fs.pathExists(file.path))) return res.status(404).json({ message: 'File not found on disk' });

    const signature = await Signature.findOne({ _id: signatureId, user: req.user._id });
    if (!signature) return res.status(404).json({ message: 'Signature not found' });

    const { bytes, height } = await stampSignature(file.path, signature.signatureData, { page: pageNumber, ...position });
    const version = await snapshotCurrentVersion(file, req.user._id, 'Before signing');
    const signedPath = newLivePath(file, '.pdf');
    await fs.writeFile(signedPath, bytes);
    await replaceFileContents(file, signedPath, bytes.length);

    const documentSignature = await DocumentSignature.create({
      file: file._id,
      user: req.user._id,
      signature: signature._id,
      pageNumber,
      position: { x: position.x, y: position.y, width: position.width, height },
      signedDocumentPath: signedPath,
    });
    await Activity.create({ user: req.user._id, file: file._id, action: 'edited', details: `Signed with "${signature.name}"` });

    res.status(201).json({
      message: 'Signed. The unsigned file is kept in Version history.',
      documentSignature,
      versionNumber: version?.versionNumber || null,
      file: { _id: file._id, originalName: file.originalName, size: file.size, updatedAt: file.updatedAt },
    });
  } catch (error) {
    console.error('Error applying signature:', error);
    res.status(error.status || 500).json({ message: error.message || 'Could not sign this PDF.' });
  }
});

router.get('/document/:fileId', auth, async (req, res) => {
  try {
    const file = await File.findById(req.params.fileId);
    
    if (!file) {
      return res.status(404).json({ message: 'File not found' });
    }
    
    if (!(await getFileRole(file, req.user._id))) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const documentSignatures = await DocumentSignature.find({ file: file._id })
      .populate('signature', 'name')
      .populate('user', 'name email')
      .sort({ signedAt: -1 });
    
    res.json(documentSignatures);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Helper function to apply signature to PDF
// Note: For now, we store signature positions and render them as overlays in the frontend
// This is more efficient and doesn't modify the original PDF
module.exports = router;

