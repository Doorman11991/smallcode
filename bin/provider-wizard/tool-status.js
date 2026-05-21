// Provider Wizard — provider_status tool handler

const { getStatus, formatStatus } = require('./status');

module.exports = function providerStatus() {
  return formatStatus(getStatus());
};
