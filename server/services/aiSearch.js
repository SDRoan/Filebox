const config = require('../config/aiConfig');

// Search runs entirely on this machine. Embeddings are hashed bag-of-words
// vectors, so search works offline, without Ollama and without any hosted API.
const EMBEDDING_DIMENSIONS = 512;
const STOP_WORDS = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'may', 'who', 'did', 'get', 'him', 'with', 'this', 'that', 'from', 'they', 'will', 'have', 'what', 'when', 'your', 'about', 'which', 'their', 'there', 'would', 'into', 'than', 'then', 'them', 'these', 'some', 'could', 'other', 'were', 'been', 'also']);

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hashToken = (token) => {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

class AISearch {
  /**
   * Generate a local embedding for text. Async to keep the existing call sites unchanged.
   */
  async generateEmbedding(text) {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const maxLength = config.extraction.maxTextLength;
    return this.hashedEmbedding(text.length > maxLength ? text.substring(0, maxLength) : text);
  }

  tokenize(text = '') {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(token => token.length > 2 && !STOP_WORDS.has(token));
  }

  hashedEmbedding(text) {
    const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);
    const tokens = this.tokenize(text);
    tokens.forEach((token) => {
      const hash = hashToken(token);
      // The sign bit spreads collisions so they cancel out instead of piling up.
      vector[hash % EMBEDDING_DIMENSIONS] += (hash & 0x80000000) ? -1 : 1;
    });
    return tokens.length ? vector : [];
  }

  /**
   * Embeddings saved before File Box went local-only have other dimensions; re-derive those from text.
   */
  embeddingFor(fileContent) {
    if (fileContent.embedding?.length === EMBEDDING_DIMENSIONS) {
      return fileContent.embedding;
    }
    return this.hashedEmbedding(fileContent.extractedText || '');
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(vecA, vecB) {
    if (vecA.length === 0 || vecA.length !== vecB.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Semantic search: find files similar to query
   */
  async semanticSearch(query, fileContents) {
    try {
      // Generate embedding for query
      const queryEmbedding = await this.generateEmbedding(query);

      if (queryEmbedding.length === 0) {
        return [];
      }

      // Calculate similarity scores
      const results = fileContents.map(fileContent => {
        const similarity = this.cosineSimilarity(queryEmbedding, this.embeddingFor(fileContent));
        return { fileContent, score: similarity };
      });

      // Sort by similarity score (descending)
      return results
        .filter(result => result.score > config.search.minSimilarityThreshold)
        .sort((a, b) => b.score - a.score);
    } catch (error) {
      console.error('Error in semantic search:', error);
      return [];
    }
  }

  /**
   * Keyword search - searches through extracted text content (not just filenames)
   */
  keywordSearch(query, fileContents) {
    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2).map(escapeRegex); // Ignore very short words

    return fileContents
      .map(fileContent => {
        const text = (fileContent.extractedText || '').toLowerCase();
        const fileName = (fileContent.file?.originalName || '').toLowerCase();
        
        let score = 0;
        const hasContent = text.length > 0;
        
        // PRIORITY 1: Content matches (much higher weight)
        if (hasContent) {
          // Exact phrase match in content (highest priority)
          if (text.includes(queryLower)) {
            score += config.scoring.exactFilenameMatch * 5; // Much higher for content
          }
          
          // Word matches in content
          queryWords.forEach(word => {
            const matches = (text.match(new RegExp(`\\b${word}\\b`, 'g')) || []).length;
            if (matches > 0) {
              score += matches * config.scoring.contentMatch * 3; // Boost content matches
            }
          });
          
          // Partial word matches in content
          queryWords.forEach(word => {
            const partialMatches = (text.match(new RegExp(word, 'g')) || []).length;
            if (partialMatches > 0) {
              score += partialMatches * config.scoring.contentMatch;
            }
          });
        }
        
        // PRIORITY 2: Filename matches (lower weight, only if no content)
        if (!hasContent || score === 0) {
          // Exact match in filename
          if (fileName.includes(queryLower)) {
            score += config.scoring.exactFilenameMatch;
          }
          
          // Word matches in filename
          queryWords.forEach(word => {
            if (fileName.includes(word.replace(/\\/g, ''))) {
              score += config.scoring.partialFilenameMatch;
            }
          });
        }
        
        return { fileContent, score };
      })
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score);
  }
}

module.exports = new AISearch();

