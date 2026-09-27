# ADR-010: Scheduling and job execution are separable roles of one binary

Status: Accepted
Date: 2026-09-16
Relates to: ADR-003, ADR-007

## Context

The attendance close scheduler ran as a fourth loop inside the worker process. That created
a dependency the deployment could not express:

```
worker ├── scheduling        (decides which tenant-days are due)
       └── job execution     (consumes the queue, renders payslips, sends mail)
```

The two have opposite pressures. Job execution is bursty — a payroll run for a large tenant
produces thousands of messages — and is the thing that falls over under load. Scheduling is
cheap and must keep ticking *precisely when* execution is struggling, because the schedule
is how the system notices it is behind.

Coupled, the failure was silent in the worst way. Deploy the API without a worker, or
saturate the worker, and attendance stops closing. Nothing errors. A month later payroll
refuses to run, citing a coverage gap nobody can explain, and the only correct remedy is a
backfill during a payroll window.

The stated target shape was `Scheduler → SQS → Workers`.

## Problem

Decide whether to introduce a separate scheduler service, and what "separate" has to mean.

## Options

1. **Leave it in the worker.** Simplest, and wrong: it is the arrangement that produced the
   silent failure.
2. **A new deployable with its own repository path, image and pipeline.** Matches the target
   diagram literally, and costs a fourth thing to build, version, deploy and page about
   before anyone has evidence the split is load-bearing at runtime.
3. **EventBridge Scheduler or cron firing an HTTP endpoint.** Moves scheduling out of the
   application entirely. Attractive until the per-tenant timezone requirement is considered:
   "the day is over" happens at a different instant for every tenant, so this becomes either
   one rule per timezone, or a fixed rule plus exactly the polling loop it was meant to
   replace — with the tenant list now living in infrastructure.
4. **One binary, roles selected by configuration.** `WORKER_ROLES=scheduler` and
   `WORKER_ROLES=consumer,publisher,notifications` are two ECS services from one image.

## Decision

**Option 4.** The worker binary exposes four roles — `publisher`, `consumer`,
`notifications`, `scheduler` — selected by `WORKER_ROLES`, all enabled by default. Splitting
them is a deployment decision, not a code change.

The runtime topology in production *is* `Scheduler → SQS → Workers`: the scheduler claims a
job and emits to the outbox; the publisher forwards it to SQS; workers and the Python
engines consume it. What is shared is the build, not the process.

An unknown role name is a startup error, not a warning. A typo in `WORKER_ROLES` that quietly
starts no scheduler is invisible until payroll is wrong.

## Reason

The pipeline the target shape asks for is about *where work flows*, and that was already
correct — the scheduler never executed a close, it emitted an event for the workforce engine.
What was wrong was the *process boundary*, and a process boundary is exactly what an
environment variable can move.

Every loop is safe to run in several instances at once: scheduling is `ON CONFLICT DO
NOTHING`, claiming is `FOR UPDATE SKIP LOCKED`, and executors are idempotent. So the split
buys independent scaling and independent blast radius without buying a distributed-systems
problem, and running two scheduler replicas is redundancy rather than a race.

Option 2 would have produced the same runtime topology for the cost of a fourth deployment
pipeline. That cost is real and permanent; the benefit over option 4 is a directory layout.

## Consequences

- Production runs three ECS services from two images. The scheduler is sized smaller and
  deployed with `deployment_minimum_healthy_percent = 100`, because it is the one service
  whose absence is invisible.
- The scheduler must be monitored by the **absence** of ticks, not by errors. A
  CloudWatch alarm on `scheduler.tick` spans with `treat_missing_data = "breaching"` is part
  of the deployment, not an optional extra.
- Running every role in one process stays supported and is the default, so local development
  and small deployments are unchanged.
- A new role cannot be added without deciding its scaling story, because it has to be named
  in `ALL_ROLES` and in the infrastructure that runs it.
