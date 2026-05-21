// Provider Wizard — /provider slash command handler

const { runWizard } = require('./wizard');
const { getStatus, formatStatus } = require('./status');

module.exports = async function providerCmd(args) {
  const arg = (args || '').trim().toLowerCase();

  if (arg === 'status' || arg === '--status' || arg === '-s') {
    const status = getStatus();
    return '\n  \x1b[1;36mProvider Status\x1b[0m\n' + formatStatus(status) + '\n';
  }

  const result = await runWizard({ interactive: true });

  if (result.success) {
    return ''; // wizard already printed the summary
  }
  return `  \x1b[31mFailed:\x1b[0m ${result.error}`;
};
