const requiredFlags = ['LIVE_E2E', 'LIVE_INTEGRATION'];
const missing = requiredFlags.filter(name => process.env[name] !== '1');

if (missing.length > 0) {
  throw new Error(
    `Live verification requires ${missing.map(name => `${name}=1`).join(' and ')}.`,
  );
}

console.log('Live integration and browser verification are enabled.');
