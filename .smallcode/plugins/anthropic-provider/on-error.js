// Hook: on_error — runs when API call fails
module.exports = async function onError({ provider, model, error }) {
  if (error?.status === 401) {
    console.log('  \x1b[31mAuth failed — check ANTHROPIC_API_KEY\x1b[0m');
  } else if (error?.status === 429) {
    console.log('  \x1b[33mRate limited by Anthropic — backing off\x1b[0m');
  }
};
