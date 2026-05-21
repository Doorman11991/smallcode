// Provider Wizard — configure_provider tool handler

const { runWizard } = require('./wizard');

module.exports = async function configureProvider(params) {
  const hasAnyParam = params.provider || params.baseUrl || params.model || params.apiKey;
  if (!hasAnyParam) {
    const result = await runWizard({ interactive: true });
    if (result.success) {
      return `Provider configured: ${result.provider} (${result.baseUrl}) model=${result.model}${result.escalation ? ` escalation=${result.escalation}` : ''}. Restart SmallCode to apply.`;
    }
    return `Configuration failed: ${result.error}`;
  }

  const result = await runWizard({
    interactive: false,
    provider: params.provider,
    baseUrl: params.baseUrl,
    model: params.model,
    apiKey: params.apiKey,
    escalationProvider: params.escalationProvider,
    escalationModel: params.escalationModel,
  });

  if (result.success) {
    return `Provider configured: ${result.provider} (${result.baseUrl}) model=${result.model}${result.escalation ? ` escalation=${result.escalation}` : ''}. Restart SmallCode to apply.`;
  }
  return `Configuration failed: ${result.error}`;
};
