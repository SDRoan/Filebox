import React from 'react';

interface WordCountProps {
  words: number;
  characters: number;
  lines: number;
}

const WordCount: React.FC<WordCountProps> = ({ words, characters, lines }) => {
  return (
    <div className="doc-word-count" aria-label="Document stats">
      <span>{words} words</span>
      <span>{characters} characters</span>
      <span>{lines} lines</span>
    </div>
  );
};

export default WordCount;
