// Hook: post_request — runs after successful Anthropic API response
module.exports = async function postRequest({ provider, model, response, usage }) {
  // Could log usage, track metrics, etc.
};
