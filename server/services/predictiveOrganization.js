const FileOrganizationPattern = require('../models/FileOrganizationPattern');
const File = require('../models/File');
const Folder = require('../models/Folder');

/**
 * Analyze file movement patterns and generate AI-powered organization suggestions
 */
class PredictiveOrganizationService {
  /**
   * Record a file movement pattern
   */
  async recordPattern(userId, file, sourceFolderId, destinationFolderId, context = {}) {
    try {
      const fileExtension = file.originalName.split('.').pop()?.toLowerCase() || '';
      const now = new Date();
      const dayOfWeek = now.getDay();
      const hour = now.getHours();

      // Determine pattern type
      let patternType = 'file_type_to_folder';
      if (context.projectContext) {
        patternType = 'project_based';
      } else if (sourceFolderId) {
        patternType = 'source_folder_to_destination';
      }

      // Check if similar pattern exists
      const existingPattern = await FileOrganizationPattern.findOne({
        user: userId,
        patternType,
        'trigger.fileType': file.mimeType,
        'trigger.fileExtension': fileExtension,
        'trigger.sourceFolder': sourceFolderId || null,
        destinationFolder: destinationFolderId,
        isActive: true
      });

      if (existingPattern) {
        // Update existing pattern
        existingPattern.occurrences += 1;
        existingPattern.lastOccurrence = now;
        
        // Recalculate confidence based on occurrences
        existingPattern.confidence = Math.min(0.95, 0.5 + (existingPattern.occurrences * 0.05));
        
        // Update context
        if (context.actionBefore) {
          existingPattern.context.actionBefore = context.actionBefore;
        }
        
        await existingPattern.save();
        return existingPattern;
      } else {
        // Create new pattern
        const destinationFolder = await Folder.findById(destinationFolderId);
        
        const newPattern = new FileOrganizationPattern({
          user: userId,
          patternType,
          trigger: {
            fileType: file.mimeType,
            fileExtension,
            sourceFolder: sourceFolderId || null,
            projectContext: context.projectContext || null,
            timeOfDay: hour,
            dayOfWeek
          },
          destinationFolder: destinationFolderId,
          destinationFolderName: destinationFolder?.name || 'Unknown',
          confidence: 0.5,
          occurrences: 1,
          lastOccurrence: now,
          context: {
            actionBefore: context.actionBefore || null,
            timeAfterUpload: context.timeAfterUpload || null,
            fileSizeRange: {
              min: file.size,
              max: file.size
            }
          }
        });

        await newPattern.save();
        
        // Generate AI explanation for new pattern
        await this.generateAIExplanation(newPattern);
        
        return newPattern;
      }
    } catch (error) {
      console.error('Error recording pattern:', error);
      throw error;
    }
  }

  /**
   * Describe a pattern in plain language. Runs locally; no hosted AI is involved.
   */
  async generateAIExplanation(pattern) {
    try {
      const destinationFolder = await Folder.findById(pattern.destinationFolder);
      if (!destinationFolder) return;

      const sourceFolder = pattern.trigger.sourceFolder
        ? await Folder.findById(pattern.trigger.sourceFolder)
        : null;
      const fileKind = pattern.trigger.fileExtension
        ? `.${pattern.trigger.fileExtension} files`
        : 'files like this';
      const from = sourceFolder ? ` from "${sourceFolder.name}"` : '';

      pattern.aiExplanation = `You usually move ${fileKind}${from} to "${destinationFolder.name}"`;
      await pattern.save();
    } catch (error) {
      console.error('Error generating pattern explanation:', error);
    }
  }

  /**
   * Get AI-powered organization suggestions for a file
   */
  async getSuggestions(userId, file, context = {}) {
    try {
      // Find matching patterns
      const fileExtension = file.originalName.split('.').pop()?.toLowerCase() || '';
      const now = new Date();
      const dayOfWeek = now.getDay();
      const hour = now.getHours();

      // Query patterns that match this file
      const matchingPatterns = await FileOrganizationPattern.find({
        user: userId,
        isActive: true,
        $or: [
          { 'trigger.fileType': file.mimeType },
          { 'trigger.fileExtension': fileExtension },
          { 'trigger.sourceFolder': file.parentFolder || null },
          { 'trigger.fileNamePattern': { $exists: false } } // Will be checked separately
        ]
      })
      .populate('destinationFolder', 'name')
      .sort({ confidence: -1, occurrences: -1 })
      .limit(10);

      if (matchingPatterns.length === 0) {
        return [];
      }

      // Use AI to analyze and rank suggestions
      const suggestions = await this.generateAISuggestions(
        file,
        matchingPatterns,
        context
      );

      return suggestions;
    } catch (error) {
      console.error('Error getting suggestions:', error);
      return [];
    }
  }

  /**
   * Rank organization suggestions from the user's own patterns (already sorted by confidence).
   */
  async generateAISuggestions(file, patterns, context) {
    return patterns
      .filter(p => p.destinationFolder)
      .map(p => ({
        patternId: p._id,
        destinationFolder: p.destinationFolder._id || p.destinationFolder,
        destinationFolderName: p.destinationFolderName,
        confidence: p.confidence,
        explanation: p.aiExplanation || `Move to ${p.destinationFolderName}`,
        reason: `${p.occurrences} occurrence${p.occurrences === 1 ? '' : 's'}`,
        occurrences: p.occurrences
      }));
  }

  /**
   * Record user feedback on a suggestion
   */
  async recordFeedback(userId, patternId, action) {
    try {
      const pattern = await FileOrganizationPattern.findOne({
        _id: patternId,
        user: userId
      });

      if (!pattern) {
        throw new Error('Pattern not found');
      }

      pattern.userFeedback.push({
        action,
        timestamp: new Date()
      });

      // Adjust confidence based on feedback
      if (action === 'accepted') {
        pattern.confidence = Math.min(0.95, pattern.confidence + 0.1);
      } else if (action === 'rejected') {
        pattern.confidence = Math.max(0.1, pattern.confidence - 0.2);
        // Deactivate if confidence drops too low
        if (pattern.confidence < 0.3) {
          pattern.isActive = false;
        }
      }

      await pattern.save();
      return pattern;
    } catch (error) {
      console.error('Error recording feedback:', error);
      throw error;
    }
  }

  /**
   * Get all active patterns for a user
   */
  async getUserPatterns(userId) {
    try {
      return await FileOrganizationPattern.find({
        user: userId,
        isActive: true
      })
      .populate('destinationFolder', 'name')
      .populate('trigger.sourceFolder', 'name')
      .sort({ confidence: -1, occurrences: -1 });
    } catch (error) {
      console.error('Error getting user patterns:', error);
      return [];
    }
  }
}

module.exports = new PredictiveOrganizationService();

