// Plugin init: verify API key is available at startup.
module.exports = async function init({ config }) {
  const keyEnv = 'ANTHROPIC_API_KEY';
  if (!process.env[keyEnv]) {
    console.log(`  \x1b[33m⚠ Anthropic plugin loaded but ${keyEnv} is not set.\x1b[0m`);
    console.log(`    Set it in your .env or environment to use the anthropic provider.`);
  }
};
