import React from 'react';

interface RulerProps {
  leftMargin?: number;
  rightMargin?: number;
}

const Ruler: React.FC<RulerProps> = ({ leftMargin = 88, rightMargin = 88 }) => {
  return (
    <div className="doc-ruler" aria-hidden="true">
      <div className="doc-ruler__track">
        <div className="doc-ruler__margin doc-ruler__margin--left" style={{ left: leftMargin }} />
        <div className="doc-ruler__margin doc-ruler__margin--right" style={{ right: rightMargin }} />
        {Array.from({ length: 33 }).map((_, index) => (
          <div key={index} className="doc-ruler__tick">
            <span>{index === 0 ? '' : index / 4}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Ruler;
