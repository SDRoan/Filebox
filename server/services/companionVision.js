const ollamaClient = require('./ollamaClient');
const config = require('../config/aiConfig');
const { canCaption, shrink } = require('./imageCaption');

// File Box AI looking at a picture the person has open ("What am I looking at?", "Summarize this"),
// with the same local vision model that writes picture captions.

const isPicture = (file) => canCaption(file);

async function lookAtPicture(file, question, persona) {
  const image = (await shrink(file.path)).toString('base64');
  const { text } = await ollamaClient.generate({
    task: 'look',
    model: config.ollama.visionModel,
    keepAlive: '2m',
    system: `${persona?.intro || 'You are File Box AI, a companion inside File Box, a file storage app.'}
${persona?.tone || ''}
The person has the picture "${file.originalName}" open and is asking about it. Look at the picture and answer their question directly.
Describe what is really visible (people, places, objects, text, mood) in 2 to 4 sentences. If the picture shows text, say what it says. Do not invent details you cannot see.`,
    content: question,
    images: [image],
  });
  return String(text || '').trim();
}

module.exports = { isPicture, lookAtPicture };
