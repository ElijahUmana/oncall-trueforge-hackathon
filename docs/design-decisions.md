# Design Decisions

## One destructive tool owns the mutation

Stable TrueForge native sandbox execution is not approval-gated. ONCALL therefore binds the complete Daytona rollback to the destructive MCP tool `rollback_execute`, making one native tool approval the production boundary.

## Rollback and permanent correction are separate

Rollback restores production quickly. A separate tested PR contains the durable bulk-write guard and remains visibly under review until an operator chooses to merge it.

## Typed evidence over shared conversation

Specialists receive isolated prompts and return typed contracts. This prevents a later worker from inheriting another worker's conclusion and makes disagreement observable.

## Events over assistant narration

The UI reconstructs state from structured TrueForge events and MCP responses. Text can explain state, but it cannot establish approval, recovery, provider delivery, or resolution.

## Preparation before credentials

Daytona can clone, reproduce, create the revert, and test without a push token. Credentials enter only after durable checkpointing, reducing the mutation surface.

## A separate native workbench

The command UI presents the operational narrative. Raw TrueForge messages and payloads remain accessible on a separate workbench route so evidence is inspectable without overwhelming the primary view.

## Stable capabilities only

The project does not claim lifecycle hooks, automatic agent-file import, or other unreleased behavior as stable functionality. Persisted events and domain audit records provide the supported audit path.
