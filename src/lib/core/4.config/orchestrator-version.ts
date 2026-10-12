// Injected by build.js; bundles built without that define (e.g. the e2e harness) report 'dev'.
declare const __NF_ORCHESTRATOR_VERSION__: string | undefined;

export const ORCHESTRATOR_VERSION =
  typeof __NF_ORCHESTRATOR_VERSION__ === 'string' ? __NF_ORCHESTRATOR_VERSION__ : 'dev';
