export const CONTRACT_VERSION = '1.0';
/** @typedef {'log-analyzer' | 'metrics-analyzer' | 'deploy-investigator' | 'code-blame'} SpecialistRole */
/** @typedef {Record<string, any>} SpecialistReport */
/** @type {SpecialistRole[]} */
export const SPECIALIST_ROLES = [
  'log-analyzer',
  'metrics-analyzer',
  'deploy-investigator',
  'code-blame',
];

const evidenceContract = `"evidence":[{"tool":"exact tool name","arguments":{},"observations":["field=value"]}],"unknowns":["facts the tools did not establish"]`;

export const SPECIALIST_CONTRACTS = {
  'log-analyzer': `{"contract_version":"1.0","role":"log-analyzer","status":"complete|insufficient","incident_id":"INC-...","service":"...","first_error_at":"RFC3339|null","error_patterns":[{"signature":"...","count":1,"sample_lines":["verbatim tool output"]}],${evidenceContract}}`,
  'metrics-analyzer': `{"contract_version":"1.0","role":"metrics-analyzer","status":"complete|insufficient","incident_id":"INC-...","service":"...","baseline":{"p50_ms":0,"p95_ms":0,"p99_ms":0,"error_rate_pct":0},"first_anomaly_at":"RFC3339|null","peak":{"p50_ms":0,"p95_ms":0,"p99_ms":0,"error_rate_pct":0},${evidenceContract}}`,
  'deploy-investigator': `{"contract_version":"1.0","role":"deploy-investigator","status":"complete|insufficient","incident_id":"INC-...","service":"...","suspect_deploy":{"id":"...","deployed_at":"RFC3339","commit":"...","author":"...","message":"...","files_changed":["..."]}|null,${evidenceContract}}`,
  'code-blame': `{"contract_version":"1.0","role":"code-blame","status":"complete|insufficient","incident_id":"INC-...","service":"...","deploy_id":"...|null","commit":"...|null","findings":[{"file":"...","start_line":1,"end_line":1,"observed_code":"verbatim line-numbered code","hypothesis":"...","symptoms_explained":["..."]}],${evidenceContract}}`,
};

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {unknown} value */
function isNullableTimestamp(value) {
  return (
    value === null ||
    (isNonEmptyString(value) && Number.isFinite(Date.parse(value)))
  );
}

/** @param {unknown} value @param {string[]} errors */
function validateEvidence(value, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push('evidence must contain at least one tool observation');
    return;
  }
  for (const [index, evidence] of value.entries()) {
    if (!isObject(evidence)) {
      errors.push(`evidence[${index}] must be an object`);
      continue;
    }
    if (!isNonEmptyString(evidence.tool))
      errors.push(`evidence[${index}].tool is required`);
    if (!isObject(evidence.arguments))
      errors.push(`evidence[${index}].arguments must be an object`);
    if (
      !Array.isArray(evidence.observations) ||
      !evidence.observations.every(isNonEmptyString)
    ) {
      errors.push(`evidence[${index}].observations must contain strings`);
    }
  }
}

/** @param {unknown} report @param {SpecialistRole} expectedRole */
export function validateSpecialistReport(report, expectedRole) {
  const errors = [];
  if (!isObject(report))
    return { valid: false, errors: ['report must be an object'] };
  if (report.contract_version !== CONTRACT_VERSION)
    errors.push(`contract_version must be ${CONTRACT_VERSION}`);
  if (report.role !== expectedRole) errors.push(`role must be ${expectedRole}`);
  if (report.status !== 'complete' && report.status !== 'insufficient') {
    errors.push('status must be complete or insufficient');
  }
  if (!isNonEmptyString(report.incident_id))
    errors.push('incident_id is required');
  if (!isNonEmptyString(report.service)) errors.push('service is required');
  if (
    !Array.isArray(report.unknowns) ||
    !report.unknowns.every(isNonEmptyString)
  ) {
    errors.push('unknowns must be an array of non-empty strings');
  }
  validateEvidence(report.evidence, errors);

  if (expectedRole === 'log-analyzer') {
    if (!isNullableTimestamp(report.first_error_at))
      errors.push('first_error_at must be RFC3339 or null');
    if (!Array.isArray(report.error_patterns))
      errors.push('error_patterns must be an array');
  }
  if (expectedRole === 'metrics-analyzer') {
    if (!isNullableTimestamp(report.first_anomaly_at))
      errors.push('first_anomaly_at must be RFC3339 or null');
    if (!isObject(report.baseline)) errors.push('baseline must be an object');
    if (!isObject(report.peak)) errors.push('peak must be an object');
  }
  if (
    expectedRole === 'deploy-investigator' &&
    report.suspect_deploy !== null
  ) {
    if (!isObject(report.suspect_deploy))
      errors.push('suspect_deploy must be an object or null');
    else {
      if (!isNonEmptyString(report.suspect_deploy.id))
        errors.push('suspect_deploy.id is required');
      if (!isNullableTimestamp(report.suspect_deploy.deployed_at))
        errors.push('suspect_deploy.deployed_at is invalid');
      if (!isNonEmptyString(report.suspect_deploy.commit))
        errors.push('suspect_deploy.commit is required');
      if (!Array.isArray(report.suspect_deploy.files_changed))
        errors.push('suspect_deploy.files_changed must be an array');
    }
  }
  if (expectedRole === 'code-blame' && !Array.isArray(report.findings)) {
    errors.push('findings must be an array');
  }

  if (
    report.status === 'complete' &&
    Array.isArray(report.unknowns) &&
    report.unknowns.length > 0
  ) {
    errors.push('complete reports cannot contain unknowns');
  }
  return { valid: errors.length === 0, errors };
}

/** @param {Record<SpecialistRole, SpecialistReport>} reports */
export function correlateReports(reports) {
  const errors = [];
  for (const role of SPECIALIST_ROLES) {
    const validation = validateSpecialistReport(reports[role], role);
    errors.push(...validation.errors.map(error => `${role}: ${error}`));
    if (reports[role]?.status !== 'complete')
      errors.push(`${role}: report is not complete`);
  }
  if (errors.length > 0) return { ready: false, errors, correlations: null };

  const logs = reports['log-analyzer'];
  const metrics = reports['metrics-analyzer'];
  const deploys = reports['deploy-investigator'];
  const code = reports['code-blame'];
  const deploy = deploys.suspect_deploy;
  if (
    logs.incident_id !== metrics.incident_id ||
    logs.incident_id !== deploys.incident_id ||
    logs.incident_id !== code.incident_id
  ) {
    errors.push('specialist incident IDs do not match');
  }
  if (
    logs.service !== metrics.service ||
    logs.service !== deploys.service ||
    logs.service !== code.service
  ) {
    errors.push('specialist services do not match');
  }
  if (
    logs.first_error_at === null ||
    metrics.first_anomaly_at === null ||
    deploy === null
  ) {
    errors.push('correlation requires log, metric, and deploy timestamps');
  }

  let deployToAnomalySeconds = null;
  let errorToAnomalySeconds = null;
  if (deploy !== null && metrics.first_anomaly_at !== null) {
    deployToAnomalySeconds =
      Math.abs(
        Date.parse(metrics.first_anomaly_at) - Date.parse(deploy.deployed_at),
      ) / 1000;
    if (deployToAnomalySeconds > 120)
      errors.push(
        'suspect deploy is more than 120 seconds from the first metric anomaly',
      );
  }
  if (logs.first_error_at !== null && metrics.first_anomaly_at !== null) {
    errorToAnomalySeconds =
      Math.abs(
        Date.parse(logs.first_error_at) - Date.parse(metrics.first_anomaly_at),
      ) / 1000;
    if (errorToAnomalySeconds > 120)
      errors.push(
        'first error is more than 120 seconds from the first metric anomaly',
      );
  }
  if (deploy !== null) {
    if (code.deploy_id !== deploy.id)
      errors.push('code finding deploy_id does not match suspect deploy');
    if (code.commit !== deploy.commit)
      errors.push('code finding commit does not match suspect deploy');
    const changed = new Set(deploy.files_changed);
    const findings = /** @type {SpecialistReport[]} */ (code.findings);
    if (!findings.some(finding => changed.has(finding.file))) {
      errors.push(
        'no code finding references a file changed by the suspect deploy',
      );
    }
    if (
      !findings.some(
        finding =>
          Array.isArray(finding.symptoms_explained) &&
          finding.symptoms_explained.length > 0,
      )
    ) {
      errors.push('code findings do not explain an observed symptom');
    }
  }

  return {
    ready: errors.length === 0,
    errors,
    correlations: {
      incident_id: logs.incident_id,
      service: logs.service,
      deploy_to_anomaly_seconds: deployToAnomalySeconds,
      error_to_anomaly_seconds: errorToAnomalySeconds,
      deploy_id: deploy?.id ?? null,
      commit: deploy?.commit ?? null,
    },
  };
}
