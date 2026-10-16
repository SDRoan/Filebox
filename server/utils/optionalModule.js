const fs = require('fs');
const { execFileSync } = require('child_process');

// Reading an iCloud placeholder can block Node's entire event loop indefinitely.
// Check availability before loading optional features; retry on the next request.
function assertAvailable(filename) {
  if (!fs.existsSync(filename)) throw new Error('Optional feature files are missing');
  if (process.platform === 'darwin') {
    const flags = execFileSync('/usr/bin/stat', ['-f', '%Sf', filename], {
      encoding: 'utf8', timeout: 1000,
    });
    if (flags.includes('dataless')) throw new Error('Optional feature files have not downloaded from iCloud');
  }
}

function optionalRoute(routePath, dependencies) {
  return (req, res, next) => {
    let route;
    try {
      [routePath, ...dependencies].forEach(assertAvailable);
      route = require(routePath);
    } catch (error) {
      console.warn('Optional feature unavailable:', error.message);
      return res.status(503).json({ message: 'This feature is temporarily unavailable while its files download. Please try again later.' });
    }
    return route(req, res, next);
  };
}
module.exports = { assertAvailable, optionalRoute };
