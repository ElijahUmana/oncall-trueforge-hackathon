# Evidence Contracts

The investigation succeeds only when all four independent reports satisfy strict contracts.

## Shared envelope

Every report contains:

- `contract_version: "1.0"`
- the exact specialist role
- incident and service identity
- `status: "complete"`
- non-empty tool evidence
- `unknowns: []`

The parent rejects markdown fences, prose around JSON, partial objects, role mismatches, empty evidence, insufficient status, and unresolved unknowns.

## Specialist responsibilities

### Log analyzer

Establishes the first relevant error timestamp, repeated signatures, counts, and representative verbatim lines.

### Metrics analyzer

Establishes the healthy baseline, first anomaly, and observed peak for latency, errors, and database round trips.

### Deploy investigator

Selects the strongest temporal candidate and preserves deploy ID, timestamp, commit, author, message, and changed files.

### Code investigator

Independently selects the deploy, reads its changed source, and returns exact line-numbered findings tied to observed symptoms.

## Correlation gates

The parent can establish root cause only when:

1. all reports identify the same incident and service;
2. deploy time, first metric anomaly, and first error align within 120 seconds;
3. deploy and code investigators agree on deploy ID and commit;
4. at least one code finding is inside the deploy's changed files;
5. the observed code explains the measured symptom;
6. every RCA claim traces to a named tool observation.

This design prevents a plausible narrative from replacing missing operational evidence.
