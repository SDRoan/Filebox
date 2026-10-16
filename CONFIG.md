# Configuration Guide

All configuration values are now externalized and can be set via environment variables. No hardcoded values remain in the codebase.

## Environment Variables

Create a `.env` file in the `server/` directory with the following variables:

### Server Configuration
```bash
PORT=5001                          # Server port (default: 5001)
CLIENT_URL=http://localhost:3000   # Frontend URL for CORS
```

### Database Configuration
```bash
MONGODB_URI=mongodb://localhost:27017/dropbox-clone
```

### JWT Configuration
```bash
JWT_SECRET=your-secret-key-change-in-production  # Change in production!
JWT_EXPIRES_IN=7d                                 # Token expiration (default: 7d)
```

### Storage Configuration
```bash
DEFAULT_STORAGE_LIMIT_BYTES=10737418240    # Default user storage limit (10GB)
MAX_FILE_SIZE_BYTES=107374182400           # Max file upload size (100GB)
```

### File Box AI (local Ollama only)

File Box AI never calls a hosted AI service. Everything runs through Ollama on your machine.
Storage, sharing and search keep working when Ollama is stopped; only AI features pause.

```bash
OLLAMA_ENABLED=true
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_ASSISTANT_MODEL=llama3.1:8b          # Chat and answers
OLLAMA_ASSISTANT_PLANNER_MODEL=llama3.1:8b  # Picks which File Box action to run
OLLAMA_SUMMARY_MODEL=llama3.1:8b            # Document summaries
OLLAMA_OCR_MODEL=glm-ocr                    # Scanned PDFs (falls back to Tesseract)
OLLAMA_TIMEOUT_MS=120000
```

Search does not need Ollama: embeddings are computed locally (hashed bag-of-words vectors).

### AI Search Configuration
```bash
AI_MAX_TEXT_LENGTH=8000              # Max text length for embeddings
AI_MIN_SIMILARITY_THRESHOLD=0.1      # Minimum similarity score (0-1)
AI_MAX_SEARCH_RESULTS=20             # Max results returned
AI_FOLDER_SEARCH_LIMIT=10            # Max folders in search results
AI_FILENAME_SEARCH_LIMIT=5           # Max filename matches
```

### Search Scoring Weights
```bash
SCORE_EXACT_FILENAME_MATCH=10        # Score for exact filename match
SCORE_PARTIAL_FILENAME_MATCH=5      # Score for partial filename match
SCORE_CONTENT_MATCH=0.5             # Score multiplier for content matches
```

### OCR Configuration
```bash
OCR_LANGUAGE=eng                    # Tesseract OCR language code
```

### MIME Type Configuration
```bash
# Supported MIME types for text extraction (comma-separated)
# Leave empty to use defaults: pdf,word,document,text,json,xml,javascript,css,html,image/*
SUPPORTED_MIME_TYPES=

# Allowed MIME types for upload (comma-separated)
# Leave empty/null to allow all types
ALLOWED_MIME_TYPES=
```

### Summaries
```bash
AI_SUMMARIZATION_ENABLED=true   # Summaries are generated on demand with OLLAMA_SUMMARY_MODEL
```

### Student features
```bash
FILEBOX_ENABLE_STUDENT_FEATURES=false   # Courses, assignments, study groups, forums, learning library
```

## Configuration Files

All configuration is centralized in:
- `server/config/appConfig.js` - Application configuration
- `server/config/aiConfig.js` - AI search configuration

These files read from environment variables and provide defaults if not set.

## Frontend Configuration

The frontend uses React environment variables. Create a `.env` file in the `client/` directory:

```bash
REACT_APP_API_URL=http://localhost:5001/api
```

## Production Deployment

**IMPORTANT**: For production, ensure you:
1. Set a strong `JWT_SECRET`
2. Set `CLIENT_URL` to your production frontend URL
3. Set `MONGODB_URI` to your production database
4. Run Ollama wherever the server runs if you want File Box AI
5. Review and adjust all limits and thresholds as needed

